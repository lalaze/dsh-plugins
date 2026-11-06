import { type Combo, type Setup } from './combos.js';
/** `combos` stays absent until the first ones are saved, so an emptied list is not filled again. */
export interface FlowConfig extends Setup {
    combos?: Combo[];
}
export declare function configFrom(value: unknown): FlowConfig;
export declare class FlowStore {
    private readonly path;
    config: FlowConfig;
    constructor(path: string);
    open(): Promise<void>;
    save(next: FlowConfig): Promise<void>;
}
export declare class ReportStore {
    private readonly file;
    private reports;
    constructor(file: string);
    open(): Promise<void>;
    /** Writes run one at a time, so an earlier one cannot land after a later one. */
    flush: () => Promise<void>;
    private writes;
    private persist;
    put(sessionId: string, report: string): void;
    take(sessionId: string): string | undefined;
}
