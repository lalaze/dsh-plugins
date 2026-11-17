import { type Combo, type Setup } from './combos.js';
import type { FlowPoint } from './engine.js';
import { type Routes } from './routes.js';
import type { CardEnd, CardState, CardStep } from './shared.js';
/**
 * `combos` stays absent until the first ones are saved, so an emptied list is not filled again. `worktree` is where a
 * typed /flow runs unless its line says otherwise: in a worktree of its own, through Autofix, instead of in the conversation.
 */
export interface FlowConfig extends Setup {
    combos?: Combo[];
    worktree?: boolean;
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
/**
 * What a flow needs to go on from where it stopped, by its card's command: the goal, models and attachments it ran
 * with, the point it had reached, and its steps so far for the card that goes on. `ms` is the time it took. A flow that
 * went on in a later card keeps only `continued`, so its card can say so.
 */
export interface FlowRecord {
    parentId: string;
    goal?: string;
    routes?: Routes;
    rounds?: number;
    attachments?: unknown[];
    point?: FlowPoint;
    steps?: CardStep[];
    ms?: number;
    end?: CardEnd;
    continued?: true;
}
/** Kept only while a flow runs or can still go on: one that passed, or was taken further, leaves little or nothing. */
export declare class FlowRecords extends JsonMap<FlowRecord> {
    constructor(file: string);
    /** Every flow of a conversation but `keep`: a newer flow there makes going on with an older one pointless. */
    dropConversation(parentId: string, keep?: string): void;
}
export {};
