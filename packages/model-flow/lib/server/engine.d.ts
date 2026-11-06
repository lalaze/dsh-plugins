import type { Role, Route, Routes } from './routes.js';
/** A row in the chat that shows a step as running until it is closed with the result. */
export interface StepRow {
    /** Which conversation is doing the step, so the row can show its progress and open it. */
    attach(childId: string): void;
    close(result: {
        kind: 'success' | 'error';
        title: string;
        body?: string;
    }): Promise<void>;
}
export interface ChildRequest {
    role: Role;
    round: number;
    route: Route;
    prompt: string;
    readOnly: boolean;
    signal: AbortSignal;
    row: StepRow;
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
    openRow(title: string): StepRow;
    /** What happened, for the conversation's own model: it took no part, and the next message may well be about it. */
    report?(text: string): void;
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
    started: (routes: Routes, rounds: number, attachments?: number) => string;
    running: (role: Role, round: number, route: Route) => string;
    finished: (role: Role, round: number, ms: number) => string;
    halted: (role: Role, round: number, ms: number) => string;
    reviewPassed: (round: number, ms: number) => string;
    sentBack: (round: number, ms: number) => string;
    askedAgain: (round: number, ms: number) => string;
    passed: (round: number, ms: number) => string;
    gaveUp: (rounds: number) => string;
    /** What the last implementer said it did and what the last reviewer found, the end of a flow's report in the chat. */
    outcome: (built: string, reviewed: string) => string;
    failed: (role: Role, reason: string) => string;
    noVerdict: string;
    stopped: string;
    reportSummary: string;
};
export declare const brief: (text: string, limit?: number) => string;
export declare function runFlow(input: FlowInput, host: FlowHost): Promise<FlowOutcome>;
