import { type SshTransport } from './core/ssh.js';
import { type TuiUsageEntry } from './tui-usage.js';
/** What Antigravity's `Authentication required` means over SSH, and on this computer; Remote Agents says the same for its chats. */
export declare const ANTIGRAVITY_SIGN_IN = "Antigravity says it is not signed in on this machine. Over SSH it needs Antigravity CLI 1.5.9 or later (`agy update`) and a sign-in of its own (`agy acp --login`). Run them in a terminal on that machine, then try again.";
/** Run here, Antigravity keeps its sign-in in the keychain, apart from the file it signs in to over SSH. */
export declare const ANTIGRAVITY_SIGN_IN_HERE = "Antigravity says it is not signed in on this computer. Run `agy acp --login` in a terminal on this computer, not over SSH (a sign-in made over SSH is kept apart), then try again.";
/**
 * `sqlite3` for a machine without the command: the database, `1` to read it as it stands (see `dsh_sql`), then queries;
 * each query's rows, one column each, a line apiece.
 */
export declare const ANTIGRAVITY_SQL_PYTHON = "import sqlite3, sys; db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro' + ('&immutable=1' if sys.argv[2] else ''), uri=True, timeout=2); [print(row[0]) for query in sys.argv[3:] for row in db.execute(query)]";
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
     * The title and preview Antigravity keeps for a conversation, each on a line of its own; nothing for a conversation it
     * has not summarized yet, which it does after the first prompt. They are in its summary database: through `sqlite3`,
     * which macOS always has, or else Python's, as many Linux machines have Python without the `sqlite3` command.
     */
    antigravityTitleRecords(conversation: string): Promise<string>;
    /**
     * What TUI conversations' CLIs logged since the last read, for their token usage: each file's new whole lines that can
     * hold usage, under a header `@ <entry> <from> <end> <capped> <file>` giving the bytes read. Claude Code's lines lose the
     * message text and its copy of tool inputs, as only the usage is wanted; a long session's log runs to megabytes.
     * Antigravity keeps no log: from its conversation's database come `state`, whether a turn runs, then `calls`, its
     * model calls since the last read (counted, not in bytes), then `steps`, the first bytes of each step since, each row
     * a JSON line. See tui-usage.ts and tui-usage-antigravity.ts.
     */
    tuiUsageLines(entries: readonly TuiUsageEntry[], signal?: AbortSignal, cap?: number): Promise<Buffer>;
    /**
     * Starts a Codex thread for `codex resume` to open, as Codex cannot be told the ID of a session it starts. App server
     * only saves the thread once it has a message or a name, and it needs no message from this connection for a name.
     * @returns the thread's ID.
     */
    codexThread(cwd: string, name: string, signal: AbortSignal): Promise<string>;
    /**
     * Starts an Antigravity conversation for `agy --conversation` to open, as Antigravity cannot be told the ID of one it
     * starts: it ignores an ID it does not know and starts another. Its ACP server makes one that the interactive CLI opens,
     * and closing it there first is what lets that CLI run turns in it.
     * @returns the conversation's ID.
     */
    /** @param here - the conversation's folder is on this computer, whose Antigravity sign-in is not the SSH one. */
    antigravityConversation(cwd: string, signal: AbortSignal, here?: boolean): Promise<string>;
}
