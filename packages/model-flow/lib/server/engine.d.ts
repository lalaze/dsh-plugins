import type { Role, Route, Routes } from './routes.js';
export interface ChildRequest {
    role: Role;
    round: number;
    route: Route;
    prompt: string;
    readOnly: boolean;
    signal: AbortSignal;
}
/** `text` is the whole reply; `closing` is its last message, without the progress sentences before it. */
export interface ChildResult {
    text: string;
    closing?: string;
    stopReason: string;
    diagnostic?: string;
}
export interface FlowHost {
    run(request: ChildRequest): Promise<ChildResult>;
    note(text: string): Promise<void>;
    now?(): number;
}
export interface FlowInput {
    goal: string;
    routes: Routes;
    rounds: number;
    signal: AbortSignal;
}
export type FlowOutcome = {
    status: 'passed';
    round: number;
} | {
    status: 'rejected';
    rounds: number;
    findings: string;
} | {
    status: 'failed';
    reason: string;
} | {
    status: 'stopped';
};
export declare function flowText(goal: string): {
    roleName: (role: Role) => string;
    time: (ms: number) => string;
    roundLabel: (round: number) => string;
    started: (routes: Routes, rounds: number) => string;
    finished: (role: Role, round: number, ms: number) => string;
    sentBack: (round: number, findings: string) => string;
    passed: (round: number, ms: number, summary: string) => string;
    gaveUp: (rounds: number, findings: string) => string;
    failed: (role: Role, reason: string) => string;
    noVerdict: string;
    stopped: string;
};
export declare const brief: (text: string, limit?: number) => string;
export declare function runFlow(input: FlowInput, host: FlowHost): Promise<FlowOutcome>;
