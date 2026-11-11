import type { TuiState, TuiStore } from './tui-state.js';
/** What the plugin saves, in one JSON file a terminal's launcher also reads; see terminal.ts. */
export declare class TerminalsState implements TuiStore {
    readonly file: string;
    private state;
    private writes;
    constructor(file: string);
    get directory(): string;
    open(): Promise<void>;
    snapshot(): TuiState;
    /** Changes are saved one after another; a change that throws saves nothing. */
    update(change: (state: TuiState) => void): Promise<void>;
    private save;
    /**
     * Remote Agents kept TUI conversations in its own state until 0.2.129. They are taken over once, from the file that
     * plugin names, and left there, so that going back to that version finds them.
     */
    adopt(remoteAgentsState: string): Promise<void>;
    /** Waits for what is being saved. */
    close(): Promise<void>;
}
