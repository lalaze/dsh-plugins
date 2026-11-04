/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 * The Remote Claude launcher runs the interactive `claude` there first, a session DSH neither drives nor records.
 * In a TUI conversation (see tui.ts) it runs the same Claude session every time, identified by DSH_SESSION_ID, which DSH
 * sets in its terminals, so that reopening the conversation resumes it.
 * DSH does not pass DSH_HOME to its terminals, so the launcher carries the home it was installed from.
 * `modules` is the compiled server root the launcher imports the store, SSH and workspace modules from.
 */
export declare function installWorkspaceTerminal(controller: {
    config?: {
        shellCandidates?: string[];
    };
}, directory: string, stateFile: string, modules?: URL): Promise<{
    shell?: string;
    dispose(): void;
}>;
