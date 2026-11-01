/**
 * The executing half: this machine's own sessions and workspaces, described for paired machines, and the requests
 * they may send. Only this half ever reaches DSH's session API; nothing here writes a session log directly.
 */
import { randomUUID } from 'node:crypto';
import { attachmentRefs, chunkText, openApprovals, openQuestions, shareEvent, titleOf } from './events.js';
import { AsyncQueue, sleep } from './queue.js';
export class CommandError extends Error {
    status;
    name = 'CommandError';
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export const emptyExecutorData = () => ({ sessions: {}, handled: {}, continued: {} });
const HANDLED_TTL = 7 * 24 * 3600_000;
const MAX_TEXT = 200_000;
const MAX_IMAGE_BASE64 = 14_000_000;
const MAX_EVENTS_BYTES = 4_000_000;
/** How often a running session is read again while nothing else announces its progress. */
const RUNNING_REREAD_MS = 2_000;
export class Executor {
    options;
    host;
    entries = new Map();
    workspaceState = { items: [], archivedSessionIds: [] };
    workspaceRev = 0;
    rev = 0;
    /** Identifies this process's change counter; a peer holding another epoch's cursor gets everything again. */
    epoch = randomUUID().slice(0, 8);
    approvals = new Map();
    questions = new Map();
    inspected = new Map();
    inflight = new Map();
    entryListeners = new Map();
    refreshing;
    /** Sessions DSH reported as changed since they were last read. */
    dirty = new Set();
    again = false;
    controller = new AbortController();
    constructor(options) {
        this.options = options;
        this.host = options.host;
    }
    /** Follow DSH's session and workspace state until {@link close}. */
    start() {
        const signal = this.controller.signal;
        const stopChanges = this.host.onSessionChange(sessionId => { if (sessionId)
            this.dirty.add(sessionId); this.schedule(); });
        signal.addEventListener('abort', stopChanges, { once: true });
        void this.loop('workspaces', async () => {
            for await (const state of this.host.workspaces(signal)) {
                this.workspaceState = state;
                this.workspaceRev = ++this.rev;
                this.schedule();
                this.options.changed();
            }
        });
        void this.loop('questions', async () => {
            for await (const { sessionId, active } of this.host.questions(signal)) {
                const open = openQuestions(active);
                if (JSON.stringify(open.map(q => q.id)) === JSON.stringify((this.questions.get(sessionId) ?? []).map(q => q.id)))
                    continue;
                if (open.length)
                    this.questions.set(sessionId, open);
                else
                    this.questions.delete(sessionId);
                this.schedule();
            }
        });
        void (async () => {
            while (!signal.aborted) {
                await this.refresh().catch(error => this.options.log?.(`Could not read sessions: ${String(error)}`));
                // Running sessions are reread on their own cadence; idle ones only when DSH reports a change.
                const running = [...this.entries.values()].some(entry => entry.state !== 'idle');
                await sleep(running ? RUNNING_REREAD_MS : 30_000, signal);
            }
        })();
    }
    close() { this.controller.abort(); }
    async loop(label, body) {
        const signal = this.controller.signal;
        while (!signal.aborted) {
            try {
                if (this.host.ready())
                    await body();
            }
            catch (error) {
                if (!signal.aborted)
                    this.options.log?.(`${label} stream ended: ${String(error)}`);
            }
            await sleep(this.host.ready() ? 2_000 : 5_000, signal);
        }
    }
    /** Read the session list again soon. */
    schedule() {
        if (this.refreshing) {
            this.again = true;
            return;
        }
        void this.refresh().catch(error => this.options.log?.(`Could not read sessions: ${String(error)}`));
    }
    /** Bring every entry up to date with DSH. Concurrent calls share one pass, plus one more if asked during it. */
    refresh() {
        if (this.refreshing) {
            this.again = true;
            return this.refreshing;
        }
        this.refreshing = (async () => {
            try {
                do {
                    this.again = false;
                    await this.pass();
                } while (this.again && !this.controller.signal.aborted);
            }
            finally {
                this.refreshing = undefined;
            }
        })();
        return this.refreshing;
    }
    async pass() {
        if (!this.host.ready())
            return;
        const signal = this.controller.signal;
        const summaries = await this.host.listSessions(signal);
        const membership = new Map();
        for (const workspace of this.workspaceState.items)
            for (const id of workspace.sessionIds)
                membership.set(id, workspace.workspaceId);
        const archived = new Set(this.workspaceState.archivedSessionIds);
        const seen = new Set();
        let changed = false;
        const queue = [...summaries];
        const worker = async () => {
            for (let summary = queue.shift(); summary; summary = queue.shift()) {
                seen.add(summary.sessionId);
                try {
                    if (await this.update(summary, membership.get(summary.sessionId), archived.has(summary.sessionId), signal))
                        changed = true;
                }
                catch (error) {
                    this.options.log?.(`Could not read session ${summary.sessionId}: ${String(error)}`);
                }
            }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
        for (const entry of this.entries.values()) {
            if (seen.has(entry.sessionId) || entry.removed)
                continue;
            this.put({ ...entry, removed: true, state: 'idle', pending: [] });
            changed = true;
            delete this.options.data.sessions[entry.sessionId];
        }
        if (changed) {
            this.options.save();
            this.options.changed();
        }
    }
    async update(summary, workspaceId, archived, signal) {
        const id = summary.sessionId;
        const cached = this.options.data.sessions[id];
        const hint = summary.projections?.kind === 'sequenced' ? summary.projections.asOfSeq : -1;
        const recent = this.inspected.get(id);
        const dirty = this.dirty.delete(id);
        const stale = dirty || !cached || cached.updatedAt !== summary.updatedAt || cached.running !== summary.running || hint > cached.lastSeq
            || (summary.running && (!recent || Date.now() - recent.at >= RUNNING_REREAD_MS));
        let info = cached;
        if (stale) {
            const inspection = await this.host.inspect(id, signal);
            const record = this.remember(id, inspection);
            info = { updatedAt: summary.updatedAt, running: summary.running, lastSeq: record.lastSeq,
                title: titleOf(inspection.events), forkOf: inspection.meta.parentSession, approvals: openApprovals(inspection.events) };
            this.options.data.sessions[id] = info;
        }
        const projectedTitle = summary.projections?.values?.title;
        const pending = [
            ...[...this.approvals.values()].filter(a => a.sessionId === id).map(a => ({ kind: 'approval', id: a.id, toolName: a.toolName, askedAt: a.askedAt, answerable: true,
                ...(a.callId ? { callId: a.callId } : {}), ...(a.reason ? { reason: a.reason } : {}) })),
            ...(info.approvals ?? []).filter(a => a.kind === 'approval' && ![...this.approvals.values()].some(own => own.sessionId === id && own.callId !== undefined && own.callId === a.callId)),
            ...(this.questions.get(id) ?? []),
        ];
        const entry = {
            sessionId: id, updatedAt: summary.updatedAt, lastSeq: Math.max(info.lastSeq, hint), archived,
            state: pending.length > 0 && summary.running ? 'waiting' : summary.running ? 'running' : 'idle',
            pending: summary.running ? pending : [],
            ...(workspaceId ? { workspaceId } : {}),
            ...(typeof projectedTitle === 'string' && projectedTitle ? { title: projectedTitle } : info.title ? { title: info.title } : {}),
            ...(summary.cwd ? { cwd: summary.cwd } : {}),
            ...(info.forkOf ? { forkOf: info.forkOf } : {}),
            ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
            ...(summary.origin ? { origin: summary.origin } : {}),
            ...(this.options.data.continued[id] ? { continuedFrom: this.options.data.continued[id] } : {}),
        };
        return this.put(entry);
    }
    /** Store an entry; bump its revision when it differs. */
    put(entry) {
        const old = this.entries.get(entry.sessionId);
        if (old) {
            const { rev: _rev, ...previous } = old;
            if (JSON.stringify(previous) === JSON.stringify(entry))
                return false;
        }
        this.entries.set(entry.sessionId, { ...entry, rev: ++this.rev });
        for (const listener of this.entryListeners.get(entry.sessionId) ?? [])
            listener(entry);
        return true;
    }
    remember(sessionId, inspection) {
        const events = [];
        const attachments = new Set();
        for (const event of inspection.events) {
            const shared = shareEvent(event);
            if (!shared)
                continue;
            events.push(shared);
            for (const ref of attachmentRefs(shared))
                attachments.add(ref.attachmentId);
        }
        const record = { at: Date.now(), lastSeq: inspection.events.at(-1)?.seq ?? -1, events, attachments };
        this.inspected.set(sessionId, record);
        // A few sessions' worth; long logs are reread when needed.
        while (this.inspected.size > 12)
            this.inspected.delete(this.inspected.keys().next().value);
        return record;
    }
    async read(sessionId, atLeast, signal) {
        const recent = this.inspected.get(sessionId);
        if (recent && recent.lastSeq >= atLeast && Date.now() - recent.at < RUNNING_REREAD_MS)
            return recent;
        return this.remember(sessionId, await this.host.inspect(sessionId, signal));
    }
    /** The revision a cursor stands for; -1 for a cursor from another process or none. */
    afterOf(since) {
        const [epoch, value] = (since ?? '').split('.');
        return epoch === this.epoch && value !== '' && Number.isFinite(Number(value)) ? Number(value) : -1;
    }
    /** Changes since a cursor from {@link changes}; an unknown cursor means everything. */
    changes(since) {
        const after = this.afterOf(since);
        const sessions = [...this.entries.values()].filter(entry => entry.rev > after).map(({ rev: _rev, ...entry }) => entry);
        return {
            cursor: `${this.epoch}.${this.rev}`,
            sessions,
            ...(this.workspaceRev > after ? { workspaces: this.workspaceEntries() } : {}),
        };
    }
    /** Something outside the executor (groups) changed: move the cursor so peers fetch again. */
    bump() { return ++this.rev; }
    revision() { return this.rev; }
    workspaceEntries() {
        return this.workspaceState.items.map((item, order) => ({ workspaceId: item.workspaceId, title: item.title, path: item.path, sessionIds: [...item.sessionIds], order }));
    }
    entry(sessionId) {
        const entry = this.entries.get(sessionId);
        if (!entry || entry.removed)
            return undefined;
        const { rev: _rev, ...rest } = entry;
        return rest;
    }
    /**
     * Shared events after `after`, in order. `through` is the last event examined, shared or not: a mirror holding
     * everything through it needs nothing before it again.
     */
    async events(sessionId, after, limit, signal, atLeast = 0) {
        if (!this.entry(sessionId))
            throw new CommandError('Unknown session', 404);
        // `atLeast` comes from a live stream that saw a later event than the last read.
        const record = await this.read(sessionId, Math.max(this.entries.get(sessionId).lastSeq, atLeast), signal);
        const events = [];
        let bytes = 0, through = after, hasMore = false;
        for (const event of record.events) {
            if (event.seq <= after)
                continue;
            const size = JSON.stringify(event).length;
            if (events.length >= limit || (events.length > 0 && bytes + size > MAX_EVENTS_BYTES)) {
                hasMore = true;
                break;
            }
            events.push(event);
            bytes += size;
            through = event.seq;
        }
        if (!hasMore)
            through = Math.max(through, record.lastSeq);
        return { events, through, lastSeq: record.lastSeq, hasMore };
    }
    /** Whether an attachment appears in what this session shares; others are never served. */
    async sharesAttachment(sessionId, attachmentId, signal) {
        if (!this.entry(sessionId))
            return undefined;
        const record = await this.read(sessionId, this.entries.get(sessionId).lastSeq, signal);
        if (!record.attachments.has(attachmentId))
            return undefined;
        for (const event of record.events)
            for (const ref of attachmentRefs(event))
                if (ref.attachmentId === attachmentId)
                    return ref;
        return undefined;
    }
    /**
     * Follow one session live. The first frame is `open`; each `event` frame says which event came before it, so a
     * mirror can tell whether it missed one in between.
     */
    live(sessionId, signal) {
        const queue = new AsyncQueue();
        const entry = this.entry(sessionId);
        if (!entry) {
            queue.push({ type: 'error', message: 'Unknown session' });
            queue.close();
            return queue;
        }
        queue.push({ type: 'open', lastSeq: entry.lastSeq, entry });
        const listeners = this.entryListeners.get(sessionId) ?? new Set();
        const onEntry = (next) => queue.push({ type: 'status', entry: next });
        listeners.add(onEntry);
        this.entryListeners.set(sessionId, listeners);
        const ping = setInterval(() => queue.push({ type: 'ping' }), 15_000);
        const stop = () => {
            clearInterval(ping);
            listeners.delete(onEntry);
            if (listeners.size === 0)
                this.entryListeners.delete(sessionId);
            queue.close();
        };
        signal.addEventListener('abort', stop, { once: true });
        void (async () => {
            let previous;
            const drafts = new Map();
            const flush = (attemptId, done = false) => {
                const draft = drafts.get(attemptId);
                if (!draft)
                    return;
                clearTimeout(draft.timer);
                draft.timer = undefined;
                draft.sent = Date.now();
                // The latest 64 KB is enough to watch a long answer being written.
                queue.push({ type: 'draft', attemptId, text: draft.text.slice(-65_536), reasoning: draft.reasoning.slice(-16_384), ...(done ? { done: true } : {}) });
                if (done)
                    drafts.delete(attemptId);
            };
            try {
                for await (const frame of this.host.follow(sessionId, signal)) {
                    if (frame.type === 'snapshot') {
                        previous = frame.cursor;
                        continue;
                    }
                    if (frame.type === 'event') {
                        const after = previous ?? frame.event.seq - 1;
                        previous = frame.event.seq;
                        const shared = shareEvent(frame.event);
                        queue.push({ type: 'event', after, through: frame.event.seq, ...(shared ? { event: shared } : {}) });
                        if (frame.event.type === 'turn/end' || frame.event.type === 'approval/asked' || frame.event.type === 'approval/decided')
                            this.schedule();
                        continue;
                    }
                    const stream = frame.frame;
                    if (stream.type === 'start')
                        drafts.set(stream.attemptId, { text: '', reasoning: '', sent: 0 });
                    else if (stream.type === 'chunk') {
                        const draft = drafts.get(stream.attemptId) ?? { text: '', reasoning: '', sent: 0 };
                        drafts.set(stream.attemptId, draft);
                        const { text, reasoning } = chunkText(stream.chunk);
                        if (text)
                            draft.text += text;
                        if (reasoning)
                            draft.reasoning += reasoning;
                        if (Date.now() - draft.sent > 200)
                            flush(stream.attemptId);
                        else
                            draft.timer ??= setTimeout(() => flush(stream.attemptId), 200);
                    }
                    else if (stream.type === 'end')
                        flush(stream.attemptId, true);
                }
            }
            catch (error) {
                if (!signal.aborted)
                    queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            }
            finally {
                for (const draft of drafts.values())
                    clearTimeout(draft.timer);
                stop();
            }
        })();
        return queue;
    }
    /**
     * Run a request from a paired machine, or from this one. A request ID that already succeeded returns the same
     * result without running again, so a retry after a lost response is harmless.
     */
    command(command) {
        const requestId = typeof command?.requestId === 'string' ? command.requestId.trim() : '';
        if (!/^[\w.:-]{8,128}$/.test(requestId))
            return Promise.reject(new CommandError('Invalid request ID'));
        const done = this.options.data.handled[requestId];
        if (done)
            return Promise.resolve(done.result);
        const running = this.inflight.get(requestId);
        if (running)
            return running;
        const task = this.run({ ...command, requestId }).then(result => {
            this.options.data.handled[requestId] = { at: Date.now(), result };
            for (const [id, handled] of Object.entries(this.options.data.handled))
                if (Date.now() - handled.at > HANDLED_TTL)
                    delete this.options.data.handled[id];
            this.options.save();
            return result;
        }).finally(() => this.inflight.delete(requestId));
        this.inflight.set(requestId, task);
        return task;
    }
    async run(command) {
        const signal = AbortSignal.timeout(60_000);
        if (!this.host.ready())
            throw new CommandError('DSH is still starting on this machine', 503);
        if (command.kind === 'create') {
            if (!this.workspaceState.items.some(item => item.workspaceId === command.workspaceId))
                throw new CommandError('Unknown workspace', 404);
            const content = promptContent(command.content);
            const sessionId = await this.host.create(command.workspaceId);
            if (command.continuedFrom && typeof command.continuedFrom.deviceId === 'string' && typeof command.continuedFrom.sessionId === 'string') {
                this.options.data.continued[sessionId] = { deviceId: command.continuedFrom.deviceId, sessionId: command.continuedFrom.sessionId };
            }
            await this.host.prompt({ sessionId, requestId: `${command.requestId}:first`, mode: 'queue', content }, signal);
            this.schedule();
            return { ok: true, sessionId };
        }
        const sessionId = typeof command.sessionId === 'string' ? command.sessionId : '';
        if (!this.entry(sessionId))
            throw new CommandError('This session is not on this machine', 404);
        switch (command.kind) {
            case 'prompt':
                await this.host.prompt({ sessionId, requestId: command.requestId, mode: command.mode === 'steer' ? 'steer' : 'queue', content: promptContent(command.content) }, signal);
                break;
            case 'cancel':
                this.host.cancel(sessionId);
                break;
            case 'approval': {
                const approval = this.approvals.get(command.approvalId);
                if (!approval || approval.sessionId !== sessionId)
                    throw new CommandError('This confirmation is no longer pending', 409);
                if (command.outcome !== 'allowed-once' && command.outcome !== 'rejected')
                    throw new CommandError('Invalid answer');
                approval.resolve(command.outcome);
                break;
            }
            case 'answer': {
                if (!Array.isArray(command.answers))
                    throw new CommandError('Invalid answer');
                const answers = command.answers.map(a => ({ id: String(a.id), selected: Array.isArray(a.selected) ? a.selected.map(String) : [], ...(typeof a.custom === 'string' ? { custom: a.custom } : {}) }));
                if (!await this.host.answerQuestion(sessionId, String(command.callId), answers))
                    throw new CommandError('This question is no longer open', 409);
                break;
            }
            default: throw new CommandError('Unknown request');
        }
        this.schedule();
        return { ok: true, sessionId };
    }
    /** The approval bridge: offer each question to paired machines that may answer it. */
    approvalBridge = (ask, signal) => {
        if (!this.options.approvalPeers())
            return undefined;
        const id = randomUUID();
        const answer = new Promise(resolve => {
            this.approvals.set(id, { id, sessionId: ask.sessionId, toolName: ask.toolName, callId: ask.callId, reason: ask.reason, askedAt: Date.now(), resolve });
        });
        signal.addEventListener('abort', () => { this.approvals.delete(id); this.schedule(); }, { once: true });
        this.schedule();
        return { answer, wait: true };
    };
}
function promptContent(parts) {
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 20)
        throw new CommandError('Write a message');
    let text = 0;
    const content = [];
    for (const part of parts) {
        const value = part;
        if (value?.type === 'text' && typeof value.text === 'string') {
            text += value.text.length;
            content.push({ type: 'text', text: value.text });
        }
        else if (value?.type === 'image' && typeof value.data === 'string' && typeof value.mediaType === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(value.mediaType)) {
            if (value.data.length > MAX_IMAGE_BASE64)
                throw new CommandError('Images are at most 10 MB');
            content.push({ type: 'image', mediaType: value.mediaType, data: value.data, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 200) } : {}) });
        }
        else
            throw new CommandError('Unsupported message content');
    }
    if (text > MAX_TEXT)
        throw new CommandError('The message is too long');
    if (!content.some(part => part.type === 'image' || part.text.trim() !== ''))
        throw new CommandError('Write a message');
    return content;
}
