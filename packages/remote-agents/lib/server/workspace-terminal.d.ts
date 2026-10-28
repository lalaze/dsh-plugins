/**
 * Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH.
 * DSH remembers one shell for every conversation, so outside a remote workspace the launcher opens the local shell.
 */
export declare function installWorkspaceTerminal(controller: {
    config?: {
        shellCandidates?: string[];
    };
}, directory: string, stateFile: string, modules?: URL): Promise<{
    shell?: string;
    dispose(): void;
}>;
