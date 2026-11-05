/** The part of DSH's terminal controller that starts a terminal's process. */
interface TerminalSpawner {
    spawn?(this: TerminalSpawner, agent: unknown, owner: unknown, request: {
        id: string;
    }, signal: AbortSignal): unknown;
    execution?(this: TerminalSpawner, agent: unknown): {
        subprocess: object;
    };
}
/**
 * DSH tells a terminal's process its session but not which terminal it is, and that is what finds a sidebar terminal's
 * holder again. DSH reads its execution environment first thing and synchronously in `spawn`, so the replacement is only ever
 * seen by that call. A DSH that works differently leaves terminals without the ID, which then end with their connection as before.
 */
export declare function passTerminalId(controller: TerminalSpawner): () => void;
/** The part of DSH's terminal controller the user's closing of a terminal goes through. */
export interface ClosableTerminals {
    close?(this: ClosableTerminals, agent: {
        id: string;
    }, id: string): Promise<void>;
}
/**
 * Closing a sidebar terminal should end what runs in it. DSH ends its process the same way when it quits, which must leave
 * the holder on the host running, and only a close passes through here. A host that cannot be reached keeps it until it expires.
 */
export declare function endClosedTerminals(controller: ClosableTerminals, end: (sessionId: string, holder: string) => Promise<void>): () => void;
/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 * The Remote Claude and Remote Codex launchers run the interactive CLI there first, a session DSH neither drives nor
 * records. In a TUI conversation of that CLI (see tui.ts) it runs the same session every time, found through DSH_SESSION_ID,
 * which DSH sets in its terminals, so that reopening the conversation resumes it.
 * On the host the shell or CLI runs in a holder (see terminal-hold.ts), so it outlives DSH and the connection; a host that
 * cannot run one gets a plain connection.
 * DSH does not pass DSH_HOME to its terminals, so the launcher carries the home it was installed from.
 * `modules` is the compiled server root the launcher imports the store, SSH and workspace modules from.
 */
export declare function installWorkspaceTerminal(controller: TerminalSpawner & {
    config?: {
        shellCandidates?: string[];
    };
}, directory: string, stateFile: string, modules?: URL): Promise<{
    shell?: string;
    dispose(): void;
}>;
export {};
