import type { TuiCli } from './core/workspace.js';
import { type TuiStore } from './tui-state.js';
import { type TuiSessions } from './tui.js';
/**
 * TUI conversations in every DSH that uses the same account on a machine. A TUI conversation's CLI runs in a terminal on
 * the machine, and no relay sees it, so the sessions Remote Agents shares never include it: only the DSH that started it
 * knew it existed. Each one is therefore listed in a small file on the machine (see `SHARED_TUI_FOLDER`), and every DSH
 * shows the listed ones it does not have yet as conversations of its own, in the remote workspace of their directory.
 * All of them open the same terminal there, whose holder takes several clients at once: each sees the same screen and
 * may type, and the screen has the size of whichever came or resized last.
 *
 * Archiving and the title follow too. Each DSH remembers what it and the list last agreed on (`TuiDetails.shared`): a
 * difference on its own side is its user's change and goes to the list, a difference in the list is someone else's and
 * is applied here. A conversation archived before it was ever listed stays out of the list, so old ones do not appear
 * elsewhere when this arrives.
 */
/** A TUI conversation as its machine lists it. `key` is its `tuiKey`; `at` is when it was listed. */
export interface SharedTui {
    v: 1;
    key: string;
    cli: TuiCli;
    thread?: string;
    cwd: string;
    title?: string;
    model?: string;
    effort?: string;
    at: string;
    archived?: boolean;
}
/** One record of the list, or nothing if it is not one this version can show. Its model and effort reach a command line. */
export declare function sharedTui(value: unknown): SharedTui | undefined;
/** The records in what `TuiRemote.sharedTuis` read. A file cut short or written by something else is passed over. */
export declare function sharedTuis(output: string): SharedTui[];
/** The file a conversation is listed in, without its extension. */
export declare const sharedTuiName: (key: string) => string;
/** A conversation of this DSH: whether it is still new, and its title if DSH told. */
export interface SharedTuiRow {
    blank: boolean;
    title?: string;
}
export interface TuiSharingHost {
    /** The saved machines whose conversations are shared with other DSHes. */
    hosts(): Promise<{
        id: string;
        label: string;
    }[]>;
    /** What `TuiRemote.sharedTuis` reads on a machine. */
    list(hostId: string, signal: AbortSignal): Promise<string>;
    put(hostId: string, name: string, record: string, signal: AbortSignal): Promise<void>;
    /** A conversation's verified machine and directory. */
    target(sessionId: string, signal: AbortSignal): Promise<{
        hostId: string;
        cwd: string;
    }>;
    /** The conversations DSH has archived, or nothing where this DSH does not tell. */
    archived(): readonly string[] | undefined;
    archive(sessionId: string, archived: boolean): Promise<void>;
    rows(): Promise<Map<string, SharedTuiRow>>;
    /** The local folder of the remote workspace for a directory, created when missing. */
    anchor(hostId: string, cwd: string, signal: AbortSignal): Promise<string>;
    /** The DSH workspace for a local folder, added when missing. */
    workspace(path: string): Promise<string>;
    /** Creates the conversation with this ID, or reuses it while blank; DSH answers with the ID it used. */
    create(workspaceId: string, sessionId: string): Promise<string>;
    warn?(message: string): void;
    now?(): number;
}
export declare class TuiSharing {
    private readonly store;
    private readonly tui;
    private readonly host;
    private timer?;
    private running?;
    private again;
    private readonly abort;
    private readonly retries;
    private readonly targets;
    private warned;
    constructor(store: TuiStore, tui: TuiSessions, host: TuiSharingHost);
    private now;
    start(): void;
    close(): void;
    /** Something changed here, such as a conversation starting: the list hears of it without waiting for the next round. */
    soon(): void;
    private schedule;
    /** One round over the shared machines. Rounds never overlap; one asked for meanwhile follows. */
    run(): Promise<void>;
    private due;
    private failed;
    private round;
    private save;
    /** Lists a conversation of this DSH, on its machine if that machine was read this round and so is known not to list it. */
    private publish;
    /** Brings a conversation of this DSH and its record together: whichever side changed since they last agreed wins. */
    private agree;
    /** Shows a listed conversation this DSH does not have, in a conversation of its own in that directory's remote workspace. */
    private adopt;
}
