import type { Route } from './routes.js';
export interface FlowConfig {
    plan?: Route;
    implement?: Route;
    review?: Route;
    rounds: number;
}
export declare function configFrom(value: unknown): FlowConfig;
export declare class FlowStore {
    private readonly path;
    config: FlowConfig;
    constructor(path: string);
    open(): Promise<void>;
    save(next: FlowConfig): Promise<void>;
}
