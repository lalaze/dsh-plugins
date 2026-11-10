import { createHash } from 'node:crypto';
import { RemoteError } from '../core/domain.js';
import { tuiHolder } from './holder-protocol.js';
/** What a conversation shows until its CLI has titled it. */
const FIRST_TITLES = { claude: 'Claude Code', codex: 'Codex' };
const MAX_TITLE = 120, MAX_PROMPT_TITLE = 80;
/** The title 0.2.81 gave every TUI conversation, which is replaced like the plugin's own. */
const OLD_TITLE = /^Claude TUI \d\d:\d\d$/;
/** Model and effort reach the remote command line inside double quotes. */
const COMMAND_VALUE = /^[\w.:[\]-]+$/;
/** The chat provider of each remote CLI. */
const PROVIDERS = { claude: 'remote-cli-claude', codex: 'remote-cli-codex' };
/**
 * Codex saves a new thread only once it has a message or a name, and `codex resume` needs it saved, so a TUI conversation's
 * thread starts with this name. It keeps Codex from titling the thread by itself, so `/rename` is the only title it can have.
 */
export const CODEX_THREAD_NAME = 'DSH TUI';
/** The Claude session of a TUI conversation: the same every launch, so that reopening it resumes. */
export function tuiClaudeSession(sessionId) {
    const hash = createHash('sha256').update(`dsh-tui:${sessionId}`).digest('hex');
    return [hash.slice(0, 8), hash.slice(8, 12), `4${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join('-');
}
/** Without a trailing space: DSH trims titles, and a difference would read as a rename. */
const promptTitle = (text) => text.slice(0, MAX_PROMPT_TITLE).trim();
/**
 * A conversation's title from Claude Code's session file: the user's /rename, then Claude's own title, then the first
 * prompt. Claude often writes no title, for a short greeting especially, and DSH titles its other conversations by their
 * first prompt too. The first `last-prompt` record holds the first prompt; a later one may have no text.
 */
export function claudeTitle(records) {
    let custom, own, prompt;
    for (const line of records.split('\n')) {
        try {
            const record = JSON.parse(line);
            if (record.type === 'custom-title')
                custom = record.customTitle;
            if (record.type === 'ai-title')
                own = record.aiTitle;
            if (record.type === 'last-prompt' && prompt === undefined && typeof record.lastPrompt === 'string') {
                const text = record.lastPrompt.replace(/\s+/g, ' ').trim();
                // A slash command says nothing about the conversation.
                if (text && !text.startsWith('/'))
                    prompt = promptTitle(text);
            }
        }
        catch { /* not a whole record */ }
    }
    const title = [custom, own].find(value => typeof value === 'string' && value.trim());
    return title?.trim().slice(0, MAX_TITLE) ?? prompt;
}
/**
 * A conversation's title from its Codex thread: the user's /rename, then the first prompt.
 * @param records - the thread's newest line of Codex's name index and the first of its user messages.
 */
export function codexTitle(records) {
    let name, prompt;
    for (const line of records.split('\n')) {
        try {
            const record = JSON.parse(line);
            if (record.thread_name !== undefined)
                name = record.thread_name;
            const item = record.payload?.item;
            if (item?.type !== 'UserMessage' || prompt !== undefined || !Array.isArray(item.content))
                continue;
            const text = item.content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(' ').replace(/\s+/g, ' ').trim();
            // A path says nothing about the conversation, like a slash command in Claude Code's.
            if (text && !text.startsWith('/'))
                prompt = promptTitle(text);
        }
        catch { /* not a whole record */ }
    }
    return typeof name === 'string' && name.trim() && name !== CODEX_THREAD_NAME ? name.trim().slice(0, MAX_TITLE) : prompt;
}
/** The model of a chat model route, `<project>/<cli>/<model>`, if it is this CLI's. */
function routeModel(route, expected) {
    if (typeof route !== 'string')
        return;
    const [, cli, model] = route.split('/');
    try {
        return cli === expected && model ? decodeURIComponent(model) : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Conversations whose main view is the interactive Claude Code or Codex instead of DSH's chat. Each stays a real DSH
 * session, so it is a row in the workspace list. DSH shows no views in a session until its log has a turn, so starting one
 * records an empty turn. The conversation itself lives in the remote CLI; see the launchers in terminal.ts.
 */
export class TuiSessions {
    store;
    dsh;
    constructor(store, dsh) {
        this.store = store;
        this.dsh = dsh;
    }
    list() { return this.store.snapshot().tuiSessions ?? []; }
    /**
     * Whether Claude Code is started with its classic renderer, which leaves the conversation in the terminal's own
     * scrollback. Its fullscreen one draws the scrolling itself: every wheel step is a trip to the host and a repaint of the
     * whole screen (about 3.5 KB at 126x47), so on a slow or lossy connection scrolling stutters while the page is idle.
     * Measured over a path of 77 ms with 2% loss: 120 ms a step and pauses of 200 ms, against 17 ms and none this way.
     * The launchers in terminal.ts read it, so it applies to a CLI when it next starts.
     */
    localScroll() { return this.store.snapshot().tuiLocalScroll !== false; }
    async setLocalScroll(local) { await this.store.update(state => { state.tuiLocalScroll = local; }); }
    /** Those of `list` that run Codex. */
    codex() {
        const { tuiSessions = [], tuiDetails } = this.store.snapshot();
        return tuiSessions.filter(id => tuiDetails?.[id]?.cli === 'codex');
    }
    /**
     * Tell DSH the conversation's model, once. A session shows its model in the workspace list only if a selection or a
     * request recorded it: a TUI conversation sends no requests, and the composer may only be showing a remembered default.
     * The icon is all that depends on this, so a failure is retried by the next title check rather than reported.
     * @param route - the composer's model route; a conversation started by an earlier version has none, so its is rebuilt.
     */
    async recordModel(sessionId, hostId, route) {
        const details = this.store.snapshot().tuiDetails?.[sessionId];
        if (details?.modelRecorded)
            return;
        const cli = details?.cli ?? 'claude';
        await this.dsh.selectModel({ sessionId, provider: PROVIDERS[cli], model: route ?? `${hostId}/${cli}/${encodeURIComponent(details?.model ?? 'default')}`,
            ...(details?.effort ? { reasoningEffort: details.effort } : {}) });
        await this.store.update(state => { state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], modelRecorded: true } }; });
    }
    /** @param selection - the CLI, and the composer's model route and effort, which its first launch uses. */
    async start(sessionId, selection, signal) {
        const cli = selection.cli === 'codex' ? 'codex' : 'claude';
        const target = await this.dsh.verify(sessionId, signal);
        if (this.list().includes(sessionId))
            return;
        const session = this.dsh.session(sessionId);
        if (!session)
            throw new RemoteError('This conversation is not open', 409);
        // Its turns would stay in DSH while the CLI started from nothing.
        if ((await this.dsh.list()).find(row => row.sessionId === sessionId)?.blank === false)
            throw new RemoteError('Only a new conversation can start in the TUI', 409);
        signal.throwIfAborted();
        const thread = cli === 'codex' ? await this.dsh.codexThread(sessionId, signal) : undefined;
        signal.throwIfAborted();
        const model = routeModel(selection.model, cli), effort = selection.effort;
        await this.store.update(state => {
            state.tuiSessions = [...state.tuiSessions ?? [], sessionId];
            state.tuiDetails = { ...state.tuiDetails, [sessionId]: { title: FIRST_TITLES[cli], ...(thread ? { cli: 'codex', thread } : {}),
                    ...(model && COMMAND_VALUE.test(model) ? { model } : {}), ...(typeof effort === 'string' && COMMAND_VALUE.test(effort) ? { effort } : {}) } };
        });
        await this.recordModel(sessionId, target.hostId, model ? selection.model : undefined).catch(() => { });
        session.append('turn/start', { turn: 1 });
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        // An agent reads its last turn once, when it is created. A later turn here, numbered 1 again, would leave a log DSH
        // refuses to load.
        const phase = this.dsh.agent?.(sessionId)?.phase;
        if (phase?.kind === 'idle')
            phase.lastTurn = 1;
        await this.dsh.rename(sessionId, FIRST_TITLES[cli]);
    }
    /** Ends the conversation's CLI, which otherwise keeps running with no DSH around. Reopening the conversation resumes it. */
    async end(sessionId, signal) {
        if (this.list().includes(sessionId))
            await this.dsh.endHolder?.(sessionId, tuiHolder(sessionId), signal);
    }
    /**
     * Follow the CLI's title, until the conversation is renamed in DSH.
     * @param current - the conversation's title in DSH.
     * @returns the new title, if it changed.
     */
    async syncTitle(sessionId, current, signal) {
        if (!this.list().includes(sessionId))
            return;
        const shown = typeof current === 'string' ? current : undefined, saved = this.store.snapshot().tuiDetails?.[sessionId];
        const renamed = shown !== undefined && shown !== saved?.title && !OLD_TITLE.test(shown);
        if (renamed && saved?.modelRecorded)
            return;
        const target = await this.dsh.verify(sessionId, signal);
        await this.recordModel(sessionId, target.hostId).catch(() => { });
        if (renamed)
            return;
        const title = saved?.thread ? codexTitle(await this.dsh.codexTitleRecords(sessionId, saved.thread, signal)) : claudeTitle(await this.dsh.titleRecords(sessionId, tuiClaudeSession(sessionId), signal));
        if (!title || title === shown)
            return;
        await this.dsh.rename(sessionId, title);
        await this.store.update(state => { state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...state.tuiDetails?.[sessionId], title } }; });
        return title;
    }
}
