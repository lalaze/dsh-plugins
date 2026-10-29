import { JsonlPeer } from './ssh.js';
import { SHARED_SCRIPT, SHARED_VERSION } from './shared-script.js';
import { attachmentInput, identifier, PROVIDER_LABELS } from './domain.js';
const HOME = '"$HOME/.dsh-remote-agents"';
const SCRIPT = `${HOME}/shared/shared-${SHARED_VERSION}.mjs`, BASE = `${HOME}/shared-v1`;
const INSTALL = `command -v node >/dev/null 2>&1 || { printf missing-node; exit 0; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { printf old-node; exit 0; }
umask 077
mkdir -p ${HOME}/shared ${BASE}
chmod 700 ${HOME} ${HOME}/shared ${BASE}
if [ ! -f ${SCRIPT} ]; then
  dsh_shared_tmp="$(mktemp ${HOME}/shared/.shared.XXXXXXXXXX)"
  cat > "$dsh_shared_tmp" <<'DSH_SHARED_SCRIPT_END'
${SHARED_SCRIPT}
DSH_SHARED_SCRIPT_END
  mv -f "$dsh_shared_tmp" ${SCRIPT}
fi
# Scripts of earlier versions; a DSH still on one installs it again when it connects.
find ${HOME}/shared -maxdepth 1 -name 'shared-*.mjs' ! -name 'shared-${SHARED_VERSION}.mjs' -mtime +7 -exec rm -f {} + 2>/dev/null
printf ready`;
/**
 * Task fields every DSH sharing a host keeps alike. Bindings to one DSH (`chat`, `owner`, `hostId`) and its
 * own diagnostics and usage counters stay local.
 */
const FIELDS = ['cwd', 'provider', 'model', 'modeId', 'thinkingOptionId', 'serviceTier', 'prompt', 'attachments', 'serverId', 'title', 'createdAt', 'updatedAt', 'modes', 'archived', 'origin',
    'agentId', 'executionCwd', 'native', 'relay', 'state'];
/** Only the DSH driving a CLI changes these; its own copy wins over an older shared one. */
const DRIVEN = new Set(['model', 'modeId', 'thinkingOptionId', 'serviceTier', 'agentId', 'executionCwd', 'native', 'relay', 'state', 'modes']);
/** Every saved task has these; a shared record never removes them. */
const REQUIRED = new Set(['cwd', 'provider', 'model', 'prompt', 'serverId', 'title', 'createdAt']);
/** Set when a session starts and never changed; a copy keeps its own, such as the full first prompt. */
const FIXED = new Set(['cwd', 'provider', 'prompt', 'attachments', 'serverId', 'createdAt', 'origin']);
/** As the store checks text fields: not blank, bounded, without NUL or carriage returns. */
const text = (max) => (v) => typeof v === 'string' && v.length <= max && !!v.trim() && !/[\0\r]/.test(v);
const absolute = (v) => text(4096)(v) && !/\n/.test(v) && /^(?:\/|[a-zA-Z]:[\\/])/.test(v);
const date = (v) => text(40)(v) && Number.isFinite(Date.parse(v));
const valid = (check) => { try {
    check();
    return true;
}
catch {
    return false;
} };
/**
 * What a saved task may hold in each shared field. A record written by another version or edited on the host
 * must never reach the local state in a shape that keeps it from loading.
 */
const VALID = {
    cwd: absolute, executionCwd: absolute, provider: v => typeof v === 'string' && Object.hasOwn(PROVIDER_LABELS, v), model: text(500),
    modeId: text(200), thinkingOptionId: text(200), serviceTier: text(200), prompt: text(100_000), attachments: v => valid(() => attachmentInput(v)),
    serverId: text(200), title: text(100), createdAt: date, updatedAt: date, archived: v => typeof v === 'boolean', origin: v => v === 'dsh', state: v => v === 'ready' || v === 'uncertain',
    modes: v => Array.isArray(v) && v.length <= 100 && v.every(m => m && typeof m === 'object' && text(200)(m.id) && typeof m.label === 'string' && m.label.length <= 200),
    agentId: v => valid(() => identifier(v)), relay: v => !!v && typeof v === 'object' && valid(() => identifier(v.id)),
    native: v => {
        const n = v;
        return !!n && typeof n === 'object' && ['codex', 'claude', 'acp', 'antigravity'].includes(String(n.protocol)) && text(500)(n.sessionId) && typeof n.initialSent === 'boolean'
            && Array.isArray(n.argv) && n.argv.length > 0 && n.argv.length <= 200 && n.argv.every(a => typeof a === 'string' && a.length <= 4096 && !a.includes('\0'))
            && (n.resumable === undefined || typeof n.resumable === 'boolean') && (n.imageInput === undefined || n.imageInput === true);
    },
};
/** Only the start of the first prompt is shared: it names the task, and listing many sessions stays small. */
const PROMPT = 2000;
/** The shared fields of a task or record; invalid values are left out and listed in `invalid`. */
function pick(value, invalid) {
    const fields = {};
    for (const field of FIELDS) {
        let v = value[field];
        if (field === 'prompt' && typeof v === 'string' && v.length > PROMPT)
            v = v.slice(0, PROMPT);
        if (v === undefined || v === null)
            continue;
        if (VALID[field](v))
            fields[field] = v;
        else
            invalid?.add(field);
    }
    return fields;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const CHUNK = 1024 * 1024;
/**
 * The sessions of one SSH host, shared with every DSH connected to the same SSH account. The registry
 * on the host holds each session's record and history. Exactly one DSH at a time holds a session's
 * lease: it drives the CLI and appends the history; the others follow the history. Any DSH takes the
 * lease over when it sends, answers or stops, and drives a CLI whose lease expired.
 */
export class SharedSessions {
    transport;
    store;
    owner;
    peer;
    instance;
    ttl = 180_000;
    started = false;
    closed = false;
    listed = false;
    connecting = false;
    attempt = 0;
    timer;
    publishTimer;
    ticker;
    refreshedAt = 0;
    /** Requests fail at once while the host cannot run the registry, for example without Node.js 18. */
    unavailable;
    error;
    workspaces = [];
    waiters = new Set();
    /** Changes reported while the full list is applied; they follow it in order. */
    queued = [];
    applying = Promise.resolve();
    sessions = new Map();
    /** The shared record as last seen, to tell local edits from remote ones. */
    known = new Map();
    checked = new Map();
    /** How much of each history the host is known to hold exactly as here. */
    acked = new Map();
    offsets = new Map();
    held = new Set();
    lives = new Map();
    chains = new Map();
    pushes = new Map();
    adopting = new Set();
    listener = () => this.schedulePublish();
    constructor(transport, store, owner) {
        this.transport = transport;
        this.store = store;
        this.owner = owner;
        store.changeListeners.add(this.listener);
    }
    get me() { return this.instance?.id ?? ''; }
    /** Another DSH's name; one on the same computer as this one is told apart by its ID. */
    name(instance, label) {
        const name = label.slice(0, 80) || 'another DSH';
        return name === this.instance?.label ? `${name} · ${instance.replace(/^dsh-/, '').slice(0, 4)}` : name;
    }
    start() {
        if (this.started || this.closed)
            return;
        this.started = true;
        void this.connect();
        this.ticker = setInterval(() => this.tick(), 500);
        this.ticker.unref?.();
    }
    /** The registry is reachable and its sessions were applied. */
    get connected() { return !!this.peer && this.listed; }
    /** Why sharing does not work right now, if it does not. */
    status() { return this.listed ? undefined : this.unavailable ?? (this.attempt > 0 ? this.error : undefined); }
    async connect() {
        this.timer = undefined;
        if (this.closed || this.connecting)
            return;
        this.connecting = true;
        let peer;
        try {
            const installed = (await this.transport.exec(INSTALL)).trim();
            if (this.closed)
                return;
            if (!installed.endsWith('ready')) {
                this.unavailable = installed === 'missing-node' || installed === 'old-node' ? 'Sharing sessions needs Node.js 18 or newer on the SSH host.' : 'The shared session registry could not be installed in ~/.dsh-remote-agents on the SSH host.';
                throw new Error(this.unavailable);
            }
            this.unavailable = undefined;
            // Created once a host answers, so an unreachable host never changes the saved state.
            this.instance ??= await this.store.instance();
            if (this.closed)
                return;
            const current = peer = new JsonlPeer(this.transport.start('/', ['sh', '-c', `exec node ${SCRIPT} serve ${BASE} "$1"`, 'dsh-shared', this.me]));
            current.onMessage(message => {
                if (message.method !== 'changed' || current !== this.peer)
                    return;
                // Changes apply in the order the host reported them.
                if (this.listed)
                    this.applying = this.applying.then(() => this.changed(message.params)).catch(() => { });
                else
                    this.queued.push(message.params);
            });
            current.onExit(error => { if (current !== this.peer)
                return; this.peer = undefined; this.listed = false; this.retry(error.message); });
            const hello = await current.request('hello', {}, 30_000);
            if (this.closed) {
                current.close();
                return;
            }
            if (Number(hello?.lease) > 0)
                this.ttl = Number(hello.lease);
            this.peer = current;
            this.queued = [];
            // Deletions made while the host was unreachable reach it before anything is imported again.
            const deletions = this.store.sharedDeletions(this.owner.hostId);
            for (const id of deletions)
                await current.request('delete', { id, label: this.instance.label });
            if (deletions.length)
                await this.store.update(state => {
                    state.sharedDeletions = state.sharedDeletions?.filter(d => d.hostId !== this.owner.hostId || !deletions.includes(d.id));
                    if (!state.sharedDeletions?.length)
                        delete state.sharedDeletions;
                });
            const sessions = [];
            for (let after, pages = 0; pages < 100; pages++) {
                const page = await current.request('list', after ? { after } : {}, 60_000);
                if (!after)
                    this.workspaces = Array.isArray(page?.workspaces) ? page.workspaces : [];
                if (Array.isArray(page?.sessions))
                    sessions.push(...page.sessions);
                if (typeof page?.next !== 'string')
                    break;
                after = page.next;
            }
            await this.reconcile(sessions, true);
            if (current !== this.peer)
                return;
            while (this.queued.length)
                await this.changed(this.queued.shift()).catch(() => { });
            if (current !== this.peer)
                return;
            this.listed = true;
            this.attempt = 0;
            this.error = undefined;
            for (const done of [...this.waiters])
                done(current);
            this.schedulePublish();
        }
        catch (error) {
            if (peer && peer === this.peer)
                this.peer = undefined;
            peer?.close();
            this.retry(error instanceof Error ? error.message : String(error));
        }
        finally {
            this.connecting = false;
        }
    }
    retry(message) {
        this.error = message;
        this.listed = false;
        if (this.unavailable)
            for (const done of [...this.waiters])
                done(undefined);
        if (this.closed || this.timer)
            return;
        const delay = this.unavailable ? 60_000 : Math.min(60_000, 1000 * 3 ** Math.min(this.attempt++, 4));
        this.timer = setTimeout(() => void this.connect(), delay);
        this.timer.unref?.();
    }
    /** `retryNow` skips a pending backoff; otherwise only a connection already under way is awaited. */
    ready(timeout, retryNow = false) {
        if (this.peer && this.listed)
            return Promise.resolve(this.peer);
        if (this.closed || this.unavailable)
            return Promise.resolve(undefined);
        if (retryNow && this.timer) {
            clearTimeout(this.timer);
            void this.connect();
        }
        // Waiting for the next attempt after a failure would hold up every action on the host.
        else if (this.started && !this.connecting && this.attempt > 0)
            return Promise.resolve(undefined);
        this.start();
        return new Promise(resolve => {
            const done = (peer) => { clearTimeout(timer); this.waiters.delete(done); resolve(peer); };
            const timer = setTimeout(() => done(undefined), timeout);
            timer.unref?.();
            this.waiters.add(done);
        });
    }
    async call(method, params, timeout = 20_000) {
        const peer = await this.ready(timeout);
        if (!peer)
            throw new Error(this.unavailable ?? this.error ?? 'The shared session registry is unavailable');
        return peer.request(method, params, timeout);
    }
    /** Operations on one session run in order. */
    serial(id, action) {
        const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => { }).then(action);
        this.chains.set(id, next);
        void next.catch(() => { }).finally(() => { if (this.chains.get(id) === next)
            this.chains.delete(id); });
        return next;
    }
    fresh(lease) { return !!lease && lease.age + (Date.now() - lease.at) < this.ttl; }
    /** Started sessions of this host, as it is identified now: those of a machine whose identity changed belong to the earlier one. */
    publishable() {
        const serverId = this.store.hosts().find(h => h.id === this.owner.hostId)?.serverId;
        return task => !!serverId && task.hostId === this.owner.hostId && task.serverId === serverId && !!task.agentId && !!task.native && task.state !== 'creating'
            && !task.chat?.sessionId.startsWith('remote-compaction-');
    }
    async changed(params) {
        if (Array.isArray(params?.workspaces))
            this.workspaces = params.workspaces;
        await this.reconcile(Array.isArray(params?.sessions) ? params.sessions : [], false);
    }
    /** Apply the host's sessions. A full list also publishes the sessions the host does not have yet. */
    async reconcile(list, full) {
        const at = Date.now(), seen = new Set();
        for (const raw of list) {
            if (!raw || typeof raw.id !== 'string')
                continue;
            seen.add(raw.id);
            try {
                await this.update({ ...raw, ...(raw.lease ? { lease: { ...raw.lease, at } } : {}) });
            }
            catch { /* One damaged record must not stop the others. */ }
        }
        if (!full)
            return;
        // Withdrawn by this DSH when it stopped sharing: shared again now.
        const revived = new Set(list.filter(s => s?.deleted && s.withdrawnBy === this.me).map(s => s.id));
        for (const task of this.store.tasks(this.publishable())) {
            if (seen.has(task.id) && !revived.has(task.id))
                continue;
            this.sessions.delete(task.id);
            this.known.delete(task.id);
            this.checked.delete(task.id);
            void this.serial(task.id, () => this.backfill(task.id, revived.has(task.id))).catch(() => { });
        }
    }
    async update(session) {
        const id = session.id, local = () => this.store.task(t => t.id === id);
        if (session.deleted) {
            this.sessions.delete(id);
            this.known.delete(id);
            this.held.delete(id);
            this.acked.delete(id);
            if (local()?.hostId === this.owner.hostId && session.withdrawnBy !== this.me)
                void this.serial(id, () => this.owner.removed(id)).catch(() => { });
            return;
        }
        if (!session.manifest)
            return;
        this.sessions.set(id, session);
        const mine = session.lease?.instance === this.me;
        if (mine)
            this.held.add(id);
        else if (this.held.delete(id))
            void this.serial(id, () => this.lost(id)).catch(() => { });
        await this.apply(id, session.manifest, mine);
        const task = local();
        if (!task || task.hostId !== this.owner.hostId)
            return;
        if (this.held.has(id))
            void this.serial(id, () => this.push(id)).catch(() => { });
        // Histories are copied when read here; one already open, such as a session on screen, follows right away.
        else if (this.owner.loaded(id))
            void this.serial(id, () => this.pull(id)).catch(() => { });
        this.adoptIfOrphaned(id);
    }
    /** A CLI still running on the host whose DSH went away, or never had one, is driven from here. */
    adoptIfOrphaned(id) {
        const session = this.sessions.get(id), task = this.store.task(t => t.id === id);
        if (!session || !task?.relay || !task.native || task.hostId !== this.owner.hostId || this.held.has(id) || this.fresh(session.lease) || this.adopting.has(id))
            return;
        this.adopting.add(id);
        setTimeout(() => { try {
            this.owner.adopt(id);
        }
        finally {
            this.adopting.delete(id);
        } }, 0);
    }
    /** Take a shared record into the local copy, importing sessions other DSH instances started. */
    async apply(id, manifest, mine) {
        if (!Number.isSafeInteger(manifest.rev) || manifest.rev < 1)
            return;
        const existing = this.store.task(t => t.id === id);
        // A change reported before one this DSH already applied, for example while it took the session over.
        if (existing?.shared && manifest.rev < existing.shared.rev && this.known.has(id))
            return;
        const invalid = new Set(), remote = pick(manifest, invalid), previous = this.known.get(id);
        this.known.set(id, remote);
        if (existing && existing.shared?.rev === manifest.rev && previous)
            return;
        const author = manifest.creator;
        const creator = author && typeof author.instance === 'string' && author.instance !== this.me && typeof author.label === 'string' ? this.name(author.instance, author.label) : undefined;
        await this.store.update(state => {
            const task = state.tasks.find(t => t.id === id);
            if (!task) {
                // Only complete, started sessions of this same SSH account are imported.
                const host = state.hosts.find(h => h.id === this.owner.hostId);
                if (!host?.serverId || remote.serverId !== host.serverId || !remote.native || !remote.agentId || [...REQUIRED].some(field => remote[field] === undefined) || state.tasks.length >= 1000)
                    return;
                if (state.sharedDeletions?.some(d => d.id === id))
                    return;
                state.tasks.push({ ...structuredClone(remote), id, hostId: this.owner.hostId, state: remote.state === 'uncertain' ? 'uncertain' : 'ready',
                    shared: { rev: manifest.rev, imported: true, ...(creator ? { creator } : {}) } });
                return;
            }
            if (task.hostId !== this.owner.hostId)
                return;
            const unchanged = task.shared?.rev === manifest.rev;
            for (const field of FIELDS) {
                const value = remote[field];
                // An invalid shared value is ignored, and a field every task needs is never removed.
                if (invalid.has(field) || FIXED.has(field) || (value === undefined && REQUIRED.has(field)))
                    continue;
                if (same(value, task[field]) || (mine && DRIVEN.has(field)))
                    continue;
                // Unchanged remotely: the local value is an edit, published next.
                if (previous ? same(value, previous[field]) : unchanged)
                    continue;
                const target = task;
                if (value === undefined)
                    delete target[field];
                else
                    target[field] = structuredClone(value);
            }
            task.shared = { ...task.shared, rev: manifest.rev, ...(creator ? { creator } : {}) };
        });
    }
    schedulePublish() {
        if (this.publishTimer || this.closed || !this.listed)
            return;
        this.publishTimer = setTimeout(() => {
            this.publishTimer = undefined;
            for (const task of this.store.tasks(this.publishable())) {
                const json = JSON.stringify(pick(task));
                if (this.checked.get(task.id) === json)
                    continue;
                this.checked.set(task.id, json);
                void this.serial(task.id, () => this.publish(task.id)).catch(() => this.checked.delete(task.id));
            }
        }, 150);
        this.publishTimer.unref?.();
    }
    /** Send the fields changed here since the shared record was last seen. */
    async publish(id) {
        const task = this.store.task(t => t.id === id);
        if (!task || !this.publishable()(task) || !this.instance)
            return;
        const fields = pick(task), known = this.known.get(id), patch = {};
        for (const field of FIELDS)
            if (!same(fields[field], known?.[field]))
                patch[field] = fields[field] ?? null;
        if (!Object.keys(patch).length)
            return;
        if (!known)
            patch.creator = { instance: this.instance.id, label: this.instance.label };
        // Seen as sent from now on: the host's report of this change must not read as an edit made elsewhere.
        this.known.set(id, fields);
        let result;
        try {
            result = await this.call('put', { id, patch });
        }
        catch (error) {
            if (this.known.get(id) === fields) {
                if (known)
                    this.known.set(id, known);
                else
                    this.known.delete(id);
            }
            throw error;
        }
        if (result?.deleted) {
            await this.owner.removed(id);
            return;
        }
        if (Number.isSafeInteger(result?.rev))
            await this.store.update(state => {
                const saved = state.tasks.find(t => t.id === id);
                if (saved && saved.shared?.rev !== result.rev)
                    saved.shared = { ...saved.shared, rev: result.rev };
            });
    }
    /** A session recorded here that the host does not know: publish it with its history. */
    async backfill(id, revive = false) {
        if (!this.instance)
            return;
        const claim = await this.call('claim', { id, force: false, label: this.instance.label, ...(revive ? { revive: true } : {}) });
        if (claim?.deleted) {
            await this.owner.removed(id);
            return;
        }
        if (claim?.claimed) {
            this.held.add(id);
            this.acked.set(id, claim.head?.seq ?? 0);
        }
        await this.publish(id);
        if (this.held.has(id))
            await this.push(id);
        // Publishing every earlier session must not keep all their histories in memory.
        this.owner.unload(id);
    }
    /** Publish a task's record now, for a change other DSH instances must see before acting, such as a new relay. */
    async flush(id) {
        if (!this.connected)
            return;
        this.checked.delete(id);
        await this.serial(id, () => this.publish(id)).catch(() => { });
    }
    /** Bring a history another DSH drives up to date before it is read here. Never throws; gives up after `timeout`. */
    async catchUp(id, timeout = 5000) {
        const session = this.sessions.get(id);
        if (!session?.head || this.held.has(id) || !this.connected)
            return;
        const target = session.head.seq;
        // Same length is enough once this DSH confirmed the history matches the host's.
        if (await (await this.owner.history(id)).length() === target && (this.acked.get(id) ?? -1) >= target)
            return;
        const done = this.serial(id, () => this.pull(id)).catch(() => { });
        await Promise.race([done, new Promise(resolve => { const timer = setTimeout(resolve, timeout); timer.unref?.(); })]);
    }
    /** Copy new history to the host while this DSH drives the session. */
    appended(id) {
        if (!this.held.has(id) || this.pushes.has(id) || this.closed)
            return;
        const timer = setTimeout(() => { this.pushes.delete(id); void this.serial(id, () => this.push(id)).catch(() => { }); }, 100);
        timer.unref?.();
        this.pushes.set(id, timer);
    }
    async push(id) {
        if (!this.held.has(id))
            return;
        const history = await this.owner.history(id), length = await history.length(), head = this.sessions.get(id)?.head?.seq ?? 0;
        let acked = this.acked.get(id) ?? Math.min(length, head);
        if (head > length && acked >= length) {
            await this.resync(id, acked);
            return;
        }
        while (acked < length && this.held.has(id)) {
            const lines = [];
            let size = 0;
            for (const line of await history.lines(acked + 1, acked + 1000)) {
                if (lines.length && size + line.length > CHUNK)
                    break;
                lines.push(line);
                size += line.length;
            }
            const result = await this.call('append', { id, seq: acked + 1, lines }, 60_000);
            if (result?.conflict === 'deleted') {
                await this.owner.removed(id);
                return;
            }
            if (result?.conflict === 'lease') {
                this.held.delete(id);
                await this.lost(id);
                return;
            }
            if (result?.conflict === 'seq') {
                const seq = Number(result.head?.seq ?? 0);
                // The host lost entries this DSH copied: copy them again. More than this DSH has: it was driven elsewhere.
                if (seq < acked) {
                    acked = seq;
                    this.acked.set(id, seq);
                    continue;
                }
                await this.resync(id, acked);
                return;
            }
            acked = Number(result.head.seq);
            this.acked.set(id, acked);
            const session = this.sessions.get(id);
            if (session)
                session.head = result.head;
        }
    }
    /** History here and on the host diverged while this DSH held the lease: take the shared history and drive the CLI again from it. */
    async resync(id, acked) {
        this.owner.yield(id);
        const history = await this.owner.history(id);
        await history.truncate(acked);
        const current = await this.call('get', { id });
        await this.download(id, history, Number(current?.head?.seq ?? 0));
        setTimeout(() => this.owner.adopt(id), 0);
    }
    /** Another DSH took the session over: drop what this DSH recorded but never copied. */
    async lost(id) {
        this.owner.yield(id);
        const acked = this.acked.get(id);
        if (acked !== undefined)
            await (await this.owner.history(id)).truncate(acked);
    }
    async pull(id) {
        if (this.held.has(id))
            return;
        const history = await this.owner.history(id);
        await this.download(id, history, this.sessions.get(id)?.head?.seq ?? 0);
    }
    /** Make the local history equal the host's first `target` entries. Returns whether it changed. */
    async download(id, history, target) {
        let length = await history.length(), changed = false;
        // Entries this DSH recorded but never copied, for example before a restart, are replaced by the host's.
        let verified = (this.acked.get(id) ?? -1) >= Math.min(length, target);
        if (length > target) {
            await history.truncate(target);
            length = target;
            changed = true;
        }
        while (length < target || !verified) {
            // Unverified, the last local entry is read again and must be the host's.
            const from = verified || !length ? length + 1 : length;
            const result = await this.call('read', { id, seq: from, ...(this.offsets.has(id) && verified ? { bytes: this.offsets.get(id) } : {}) }, 60_000);
            let lines = Array.isArray(result?.lines) ? result.lines.slice(0, target - from + 1) : [];
            if (!verified) {
                verified = true;
                if (from === length) {
                    const [local] = await history.lines(length, length);
                    if (lines[0] !== local) {
                        await history.truncate(0);
                        length = 0;
                        changed = true;
                        this.offsets.delete(id);
                        continue;
                    }
                    lines = lines.slice(1);
                }
            }
            if (!lines.length)
                break;
            await history.importLines(lines);
            length += lines.length;
            changed = true;
            if (Number.isSafeInteger(result.bytes))
                this.offsets.set(id, result.bytes);
        }
        this.acked.set(id, length);
        return changed;
    }
    /**
     * Make this DSH the one driving a session. With `force` the lease is taken from another DSH;
     * without it only a free or expired one is. The local record and history then match the host's.
     */
    async acquire(id, force, timeout = 8000, retryNow = force) {
        if (!await this.ready(timeout, retryNow))
            return { status: 'unavailable' };
        return this.serial(id, async () => {
            const session = this.sessions.get(id);
            if (this.held.has(id) && session?.lease?.instance === this.me && this.fresh(session.lease))
                return { status: 'claimed' };
            const result = await this.call('claim', { id, force, label: this.instance.label });
            if (result?.deleted) {
                await this.owner.removed(id);
                return { status: 'deleted' };
            }
            const lease = result?.lease ? { ...result.lease, at: Date.now() } : undefined;
            if (!result?.claimed) {
                if (session)
                    session.lease = lease;
                return { status: 'held' };
            }
            const before = this.held.has(id);
            this.held.add(id);
            const current = await this.call('get', { id });
            if (current?.manifest) {
                this.sessions.set(id, { ...current, lease });
                await this.apply(id, current.manifest, before);
            }
            else if (session)
                session.lease = lease;
            const history = await this.owner.history(id), length = await history.length(), head = Number(current?.head?.seq ?? 0);
            // This DSH drove it last, or the host has no record of it yet: its own history is kept, and copied next.
            if ((before || !current?.manifest) && length >= head) {
                this.acked.set(id, Math.min(this.acked.get(id) ?? head, head));
                void this.serial(id, () => this.push(id)).catch(() => { });
                return { status: 'claimed' };
            }
            return { status: 'claimed', changed: await this.download(id, history, head) };
        });
    }
    /** Whether a relay may be attached from here. Never blocks a CLI when the registry cannot be reached. */
    async mayAttach(id) {
        // Reconnecting after an outage checks the registry first: another DSH may have taken over meanwhile.
        const result = await this.acquire(id, false, 10_000, true).catch(() => ({ status: 'unavailable' }));
        if (result.status === 'held' || result.status === 'deleted')
            return false;
        // The history moved on elsewhere: the session is rebuilt from it before attaching.
        if (result.changed) {
            setTimeout(() => this.owner.adopt(id), 0);
            return false;
        }
        return true;
    }
    /** Publish live status and keep the leases of driven CLIs from expiring. */
    tick() {
        if (!this.peer || !this.listed)
            return;
        for (const id of this.held) {
            const agent = this.owner.live(id);
            if (!agent)
                continue;
            const live = { status: agent.status, activeTurn: agent.activeTurn ?? null, pendingPermissions: agent.pendingPermissions, ...(agent.lastError ? { lastError: agent.lastError } : {}),
                ...(agent.reconnecting ? { reconnecting: true } : {}), ...(agent.resumable !== undefined ? { resumable: agent.resumable } : {}), ...(agent.context ? { context: agent.context } : {}) };
            const json = JSON.stringify(live);
            if (this.lives.get(id) === json)
                continue;
            this.lives.set(id, json);
            void this.call('live', { id, live }).catch(() => { if (this.lives.get(id) === json)
                this.lives.delete(id); });
        }
        if (Date.now() - this.refreshedAt < this.ttl / 4)
            return;
        this.refreshedAt = Date.now();
        // An expired lease changes no file on the host, so expiry is checked here.
        for (const id of this.sessions.keys())
            this.adoptIfOrphaned(id);
        const ids = [...this.held].filter(id => { const agent = this.owner.live(id); return agent && agent.status !== 'closed'; });
        if (ids.length)
            void this.call('refresh', { ids }).then(result => {
                for (const id of Array.isArray(result?.refreshed) ? result.refreshed : []) {
                    const lease = this.sessions.get(id)?.lease;
                    if (lease) {
                        lease.age = 0;
                        lease.at = Date.now();
                    }
                }
            }).catch(() => { });
    }
    /** Live status reported by the DSH driving the session, when that is another one. */
    remoteLive(id) {
        const session = this.sessions.get(id);
        if (!session?.live || !session.lease || session.lease.instance === this.me || session.live.instance !== session.lease.instance || !this.fresh(session.lease))
            return;
        const { instance: _instance, ...live } = session.live;
        delete live.at;
        return structuredClone(live);
    }
    /** The other DSH driving a session, by name. */
    controller(id) {
        const lease = this.sessions.get(id)?.lease;
        return lease && lease.instance !== this.me && this.fresh(lease) ? this.name(lease.instance, lease.label) : undefined;
    }
    /** Delete a session for every DSH; the deletion is kept until the host can be reached. */
    async delete(id) {
        this.held.delete(id);
        this.known.delete(id);
        this.sessions.delete(id);
        this.acked.delete(id);
        // An unreachable host never delays a deletion.
        try {
            if (!this.connected)
                throw new Error('offline');
            await this.call('delete', { id, label: this.instance?.label ?? '' }, 5000);
        }
        catch {
            await this.store.update(state => { state.sharedDeletions = [...(state.sharedDeletions ?? []).filter(d => d.id !== id), { hostId: this.owner.hostId, id }]; });
        }
    }
    /**
     * Stop sharing sessions started here: each is caught up from the host and taken over, then removed from the
     * registry, so other DSH instances forget it. Needs the host unless sharing never worked there.
     */
    async withdraw(ids) {
        if (!await this.ready(15_000, true)) {
            if (this.unavailable)
                return;
            throw new Error('Connect to this machine to stop sharing it, so its sessions can be withdrawn from the other DSH instances.');
        }
        for (const id of ids) {
            if (!this.sessions.has(id))
                continue;
            const result = await this.acquire(id, true, 15_000);
            if (result.status === 'unavailable')
                throw new Error(this.error ?? 'The shared session registry is unavailable');
            if (result.status === 'deleted')
                continue;
            await this.call('delete', { id, label: this.instance?.label ?? '', withdrawn: true });
            this.held.delete(id);
            this.sessions.delete(id);
            this.known.delete(id);
            this.owner.unload(id);
        }
    }
    /** Whether the registry answers now, connecting at once if needed. A host that cannot run it shares nothing. */
    async reachable(timeout) {
        const peer = await this.ready(timeout, true);
        if (!peer)
            return !!this.unavailable;
        // A connection that just dropped still looks open until its end is noticed.
        try {
            await peer.request('hello', {}, Math.min(timeout, 5000));
            return true;
        }
        catch {
            return false;
        }
    }
    /** Let another DSH drive a session right away. */
    async release(id) {
        // An unreachable host lets the lease expire instead.
        if (!this.held.delete(id) || !this.connected)
            return;
        await this.call('release', { id }, 5000).catch(() => { });
    }
    async addWorkspace(path) {
        // The name is known once the registry answered.
        if (!await this.ready(20_000))
            throw new Error(this.unavailable ?? this.error ?? 'The shared session registry is unavailable');
        await this.call('addWorkspace', { path, label: this.instance?.label ?? '' });
    }
    /** Workspaces any DSH added on this SSH account. */
    async listWorkspaces(timeout = 8000) {
        if (!await this.ready(timeout))
            throw new Error(this.unavailable ?? this.error ?? 'The shared session registry is unavailable');
        return structuredClone(this.workspaces);
    }
    close() {
        this.closed = true;
        this.listed = false;
        this.store.changeListeners.delete(this.listener);
        clearTimeout(this.timer);
        clearTimeout(this.publishTimer);
        clearInterval(this.ticker);
        for (const timer of this.pushes.values())
            clearTimeout(timer);
        for (const done of [...this.waiters])
            done(undefined);
        const peer = this.peer;
        this.peer = undefined;
        peer?.close();
    }
}
