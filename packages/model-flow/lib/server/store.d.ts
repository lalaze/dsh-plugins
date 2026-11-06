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
