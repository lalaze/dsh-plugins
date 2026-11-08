import { type Combo, type Setup } from './combos.js';
import type { CardState } from './shared.js';
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
/** A small map kept in one JSON file, oldest entries dropped first. Writes run one at a time, so an earlier one cannot land after a later one. */
declare class JsonMap<T> {
    private readonly file;
    private readonly limit;
    protected entries: Map<string, T>;
    constructor(file: string, limit: number);
    open(): Promise<void>;
    flush: () => Promise<void>;
    private writes;
    protected persist(): void;
    get(key: string): T | undefined;
    put(key: string, value: T): void;
    delete(key: string): void;
}
/** Flow results waiting for a conversation's next message, which can come after DSH restarts. */
export declare class ReportStore extends JsonMap<string> {
    constructor(file: string);
    take(sessionId: string): string | undefined;
}
/**
 * The card of a flow that is still running, by its command. A finished card is saved in the chat itself; a card whose
 * DSH stopped never finishes, so this is what it can still show afterwards: the steps it got through.
 */
export declare class CardStore extends JsonMap<CardState> {
    constructor(file: string);
}
export {};
