import type { Role, Route, Routes } from './routes.js';
import { type CardEnd, type StepStatus } from './shared.js';
/** One step in the flow's card, shown running until it is closed with how it ended. */
export interface StepRow {
    /** Which conversation is doing the step, so the card can show its progress and open it. */
    attach(childId: string): void;
    close(result: {
        status: Exclude<StepStatus, 'running'>;
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
/** How the flow ended, with the report for the chat when there is work to report. */
export type FlowEnd = CardEnd & {
    report?: string;
};
export interface FlowHost {
    run(request: ChildRequest): Promise<ChildResult>;
    openRow(step: {
        role: Role;
        round: number;
        route: Route;
    }): StepRow;
    /** Called once, whichever way the flow ends. */
    finish?(end: FlowEnd): Promise<void>;
    /** What happened, for the conversation's own model: it took no part, and the next message may well be about it. */
    report?(text: string): void;
    /** Before each step: where to go on from if the flow stops during it. */
    reached?(point: FlowPoint): void;
    now?(): number;
}
/**
 * Where a flow stands before one of its steps: enough for a new run to go on from there. `summary` is the implementer's
 * reply the step builds on (the round before for an implementation, this round's for a review), `findings` the last
 * review's; `built` and `reviewed` are what the report would say so far.
 */
export interface FlowPoint {
    stage: Role;
    round: number;
    plan?: string;
    summary?: string;
    findings?: string;
    built?: string;
    reviewed?: string;
}
/**
 * `from` goes on from a point another run reached, skipping what was done; `retry` says the step there was cut off, so
 * the implementer may find half its work in the tree. `spent` is how long the earlier runs took, which the end counts in.
 */
export interface FlowInput {
    goal: string;
    routes: Routes;
    rounds: number;
    signal: AbortSignal;
    from?: FlowPoint & {
        retry?: boolean;
    };
    spent?: number;
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
export declare const hasCjk: (text: string) => boolean;
export declare function flowText(goal: string): {
    roleName: (role: Role) => string;
    time: (ms: number) => string;
    started: (routes: Routes, rounds: number, attachments?: number) => string;
    passed: (round: number, ms: number) => string;
    gaveUp: (rounds: number) => string;
    /** What the last implementer said it did and what the last reviewer found, the end of a flow's report in the chat. */
    outcome: (built: string, reviewed: string) => string;
    failed: (role: Role, reason: string) => string;
    noVerdict: string;
    stopped: string;
    /** The first line a flow's card is saved with, which is also what DSH shows without this plugin. */
    ended(end: CardEnd): string;
    reportSummary: string;
};
export declare const brief: (text: string, limit?: number) => string;
export declare function runFlow(input: FlowInput, host: FlowHost): Promise<FlowOutcome>;
