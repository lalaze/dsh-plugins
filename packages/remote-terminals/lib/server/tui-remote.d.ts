import { type SshTransport } from './core/ssh.js';
import { type TuiUsageEntry } from './tui-usage.js';
/** What terminals and TUI conversations run on a machine, over its SSH connection. */
export declare class TuiRemote {
    private readonly transport;
    constructor(transport: SshTransport);
    /** Ends a terminal's holder and what runs in it, if there is one. */
    endHolder(holder: string): Promise<void>;
    /** The records that can title a Claude Code session, from its file on this machine if it has saved that session. */
    claudeTitleRecords(claudeSession: string): Promise<string>;
    /** The records that can title a Codex thread: its newest line of Codex's name index and its first user messages. */
    codexTitleRecords(thread: string): Promise<string>;
    /**
     * What TUI conversations' CLIs logged since the last read, for their token usage: each file's new whole lines that can
     * hold usage, under a header `@ <entry> <from> <end> <capped> <file>` giving the bytes read. Claude Code's lines lose the
     * message text and its copy of tool inputs, as only the usage is wanted; a long session's log runs to megabytes.
     * See tui-usage.ts.
     */
    tuiUsageLines(entries: readonly TuiUsageEntry[], signal?: AbortSignal, cap?: number): Promise<Buffer>;
    /**
     * Starts a Codex thread for `codex resume` to open, as Codex cannot be told the ID of a session it starts. App server
     * only saves the thread once it has a message or a name, and it needs no message from this connection for a name.
     * @returns the thread's ID.
     */
    codexThread(cwd: string, name: string, signal: AbortSignal): Promise<string>;
}
