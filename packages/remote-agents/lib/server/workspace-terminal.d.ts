/** Native terminal keeps its PTY, resizing and keyboard handling; the selected shell runs SSH. */
export declare function installWorkspaceTerminal(controller: {
    config?: {
        shellCandidates?: string[];
    };
}, directory: string, stateFile: string, modules?: URL): Promise<() => void>;
