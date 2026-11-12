/**
 * The part of DSH's terminal controller that starts a terminal's process. Up to 0.2.2-rc.1 that is
 * `spawn(agent, owner, request, signal)`; from 0.2.2-rc.2 `userLaunch(agent, request, signal)` chooses the shell and
 * `spawn(agent, owner, id, prepare, signal)` runs what it prepared. Every argument is passed on as given, so a further
 * change of these private methods does not take terminals down with it.
 */
interface TerminalSpawner {
    spawn?(this: TerminalSpawner, ...args: unknown[]): unknown;
    userLaunch?(this: TerminalSpawner, ...args: unknown[]): unknown;
    execution?(this: TerminalSpawner, agent: unknown): {
        subprocess: object;
    };
}
/**
 * DSH tells a terminal's process its session but not which terminal it is, and that is what finds a sidebar terminal's
 * holder again. From DSH 0.2.2-rc.2 the ID joins the environment `spawn` is handed. Earlier, DSH reads its execution
 * environment first thing and synchronously in `spawn`, so the replacement is only ever seen by that call. A DSH that
 * works differently leaves terminals without the ID, which then end with their connection as before.
 */
export declare function passTerminalId(controller: TerminalSpawner): () => void;
/**
 * A browser remembers a launcher by its full path: for a sidebar terminal to start again after DSH restarts, and for what
 * New terminal opens. The folder is the installed plugin's, and it moved when terminals left Remote Agents. DSH refuses a
 * path it does not offer now, so one that names a launcher in another folder starts today's launcher of that name.
 * Stop this before whatever replaced `spawn` earlier.
 */
export declare function followMovedLaunchers(controller: TerminalSpawner, launchers: readonly string[]): () => void;
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
 * `state` names the files it reads the saved machines and the TUI conversations from; `modules` is the compiled server
 * root it imports the SSH and workspace modules from.
 */
export declare function installWorkspaceTerminal(controller: TerminalSpawner & {
    config?: {
        shellCandidates?: string[];
    };
}, directory: string, state: {
    hosts: string;
    tui: string;
}, modules?: URL): Promise<{
    shell?: string;
    dispose(): void;
}>;
export {};
