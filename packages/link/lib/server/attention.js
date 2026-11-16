/**
 * What needs the user on this machine: approvals and questions waiting, turns that finished or failed, turns that run.
 * Folded from the `session/event` feed of every Session, including ones no page has open. Event shapes follow DSH
 * 0.2.2 (`@deepseek-ai/dsh-session`, `-user-approval`, `-user-questions`).
 */
/**
 * How long a run that only DSH's running status reports waits for a turn of DSH's own before it counts by itself. DSH
 * logs its own turns right as they start; a TUI conversation's turns run in a terminal and are never logged.
 */
export const STATUS_GRACE_MS = 1_500;
const record = (value) => typeof value === 'object' && value !== null ? value : {};
const text = (value) => typeof value === 'string' ? value : '';
/** The first question of logged `ask_user_question` arguments. */
export function firstQuestion(argumentsText) {
    try {
        const questions = record(JSON.parse(argumentsText)).questions;
        if (!Array.isArray(questions))
            return '';
        const first = record(questions[0]);
        return text(first.header) || text(first.question);
    }
    catch {
        return '';
    }
}
/** A timed question's tool result that leaves the question open for a late reply. */
function pendingResult(content) {
    const parts = Array.isArray(content) ? content : [content];
    return parts.some(part => /"status"\s*:\s*"pending"/.test(typeof part === 'string' ? part : text(record(part).text)));
}
export class AttentionTracker {
    titleOf;
    statusGraceMs;
    epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessions = new Map();
    listeners = new Set();
    next = 1;
    statusRuns = 0;
    /**
     * @param titleOf - the title of a Session joined mid-log (its `session/title` events came before this plugin).
     * @param statusGraceMs - see {@link STATUS_GRACE_MS}.
     */
    constructor(titleOf = () => undefined, statusGraceMs = STATUS_GRACE_MS) {
        this.titleOf = titleOf;
        this.statusGraceMs = statusGraceMs;
    }
    snapshot() {
        const waiting = [];
        const running = [];
        for (const state of this.sessions.values()) {
            waiting.push(...[...state.waits.values()].map(frame => ({ ...frame, title: state.title })));
            if (state.running)
                running.push({ ...state.running, title: state.title });
        }
        return { epoch: this.epoch, waiting: waiting.sort((a, b) => a.id - b.id), running: running.sort((a, b) => a.id - b.id) };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    /** A Session left the store: what it waited for and ran is over. */
    forget(sessionId) {
        const state = this.sessions.get(sessionId);
        if (!state)
            return;
        clearTimeout(state.pending);
        for (const key of state.waits.keys())
            this.emit('resolved', sessionId, key, '', Date.now());
        if (state.running)
            this.emit('idle', sessionId, state.running.key, '', Date.now());
        this.sessions.delete(sessionId);
    }
    observe(session, event) {
        const sessionId = session.id;
        const state = this.state(session);
        const data = record(event.data);
        switch (event.type) {
            case 'session/title':
                state.title = text(data.title);
                return;
            case 'approval/asked': {
                const id = text(data.id);
                if (id)
                    state.waits.set(id, this.emit('approval', sessionId, id, text(data.reason) || text(data.toolName), event.time));
                return;
            }
            case 'approval/decided': {
                const id = text(data.id);
                if (state.waits.delete(id))
                    this.emit('resolved', sessionId, id, text(data.outcome), event.time);
                return;
            }
            case 'tool/call': {
                if (data.name !== 'ask_user_question')
                    return;
                const callId = text(data.callId);
                if (callId)
                    state.waits.set(callId, this.emit('question', sessionId, callId, firstQuestion(text(data.arguments)), event.time));
                return;
            }
            case 'tool/result': {
                const message = record(data.message);
                const callId = text(message.toolCallId);
                if (!state.waits.has(callId) || pendingResult(message.content))
                    return;
                state.waits.delete(callId);
                this.emit('resolved', sessionId, callId, '', event.time);
                return;
            }
            case 'user/message': {
                const source = record(data.source);
                const callId = text(source.callId);
                if (source.kind === 'user-question-reply' && state.waits.delete(callId))
                    this.emit('resolved', sessionId, callId, '', event.time);
                return;
            }
            case 'turn/start':
                clearTimeout(state.pending);
                state.pending = undefined;
                state.running = this.emit('running', sessionId, `turn:${String(data.turn)}`, '', event.time);
                return;
            case 'turn/end': {
                const running = state.running;
                state.running = undefined;
                if (running)
                    this.emit('idle', sessionId, running.key, '', event.time);
                const reason = record(data.reason);
                const kind = text(reason.kind);
                // A stop by the user, and the closers DSH writes on recovery or forks, are not news.
                if (kind === 'interrupted' || kind === 'forked' || kind === 'aborted')
                    return;
                const key = `turn:${String(data.turn)}`;
                if (kind === 'completed' || kind === 'max-tokens')
                    this.emit('done', sessionId, key, '', event.time);
                else
                    this.emit('failed', sessionId, key, text(record(reason.error).message) || kind, event.time);
                return;
            }
            default:
        }
    }
    /**
     * DSH's running status of a conversation (`api-session/status`). DSH sends it for its own turns, which the log tells
     * better, and remote-terminals sends it for TUI conversations, whose turns run in a terminal and never reach the log.
     * So a run counts here only when no logged turn starts within {@link STATUS_GRACE_MS}, and only such a run ends here,
     * as finished: a terminal does not say whether its turn failed or was stopped.
     */
    status(session, running, time = Date.now()) {
        const state = this.state(session);
        if (running) {
            if (state.running || state.pending)
                return;
            const pending = setTimeout(() => {
                if (state.pending !== pending)
                    return;
                state.pending = undefined;
                if (state.running || this.sessions.get(session.id) !== state)
                    return;
                state.running = this.emit('running', session.id, `status:${++this.statusRuns}`, '', Date.now());
            }, this.statusGraceMs);
            pending.unref?.();
            state.pending = pending;
            return;
        }
        if (state.pending) {
            clearTimeout(state.pending);
            state.pending = undefined;
            return;
        }
        const run = state.running;
        if (!run?.key.startsWith('status:'))
            return;
        state.running = undefined;
        this.emit('idle', session.id, run.key, '', time);
        this.emit('done', session.id, run.key, '', time);
    }
    state(session) {
        let state = this.sessions.get(session.id);
        if (!state) {
            let title = '';
            // A title lookup that fails must not lose the event: DSH swallows a listener's throw.
            try {
                title = this.titleOf(session) ?? '';
            }
            catch { /* no title yet */ }
            state = { session, title, waits: new Map() };
            this.sessions.set(session.id, state);
        }
        return state;
    }
    emit(kind, sessionId, key, detail, time) {
        const state = this.sessions.get(sessionId);
        // A Session first seen before its title existed (a new conversation, or a TUI one joined by its status) may have one now.
        if (state && !state.title) {
            try {
                state.title = this.titleOf(state.session) ?? '';
            }
            catch { /* still none */ }
        }
        const frame = { id: this.next++, kind, sessionId, title: state?.title ?? '', key, detail, time };
        for (const listener of [...this.listeners]) {
            try {
                listener(frame);
            }
            catch { /* a subscriber's problem */ }
        }
        return frame;
    }
}
