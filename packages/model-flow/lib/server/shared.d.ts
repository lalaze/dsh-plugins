/** Used on both sides, so it must not import anything from Node. */
import type { Role } from './routes.js';
export declare const API_PATH = "/api/model-flow";
export interface EffortOption {
    id: string;
    label: string;
}
export type Locale = 'en' | 'zh';
/** Commands the flow runs itself start with this invisible character, so the client knows them from typed ones. */
export declare const MARK = "\u2063";
/** How a step ended. A review ends as passed, sent back, or without a verdict (asked again). */
export type StepStatus = 'running' | 'done' | 'passed' | 'sentBack' | 'noVerdict' | 'failed' | 'stopped';
/** `note` is the first line of a sent-back, failed or verdict-less step's result, shown under it without opening it. */
export interface CardStep {
    role: Role;
    round: number;
    model: string;
    machine?: string;
    status: StepStatus;
    ms?: number;
    childId?: string;
    body?: string;
    note?: string;
}
export type CardEnd = {
    kind: 'passed';
    round: number;
    sentBack: number;
    ms: number;
} | {
    kind: 'rejected';
    rounds: number;
    ms: number;
} | {
    kind: 'failed';
    role: Role;
    reason: string;
    ms: number;
} | {
    kind: 'stopped';
    ms: number;
} | {
    kind: 'noVerdict';
    ms: number;
};
/** One flow, drawn as one card. `zh` is the goal's language, which the card speaks whatever the UI language is. */
export interface CardState {
    parentId: string;
    zh: boolean;
    rounds: number;
    planned?: boolean;
    steps: CardStep[];
    end?: CardEnd;
}
/** A running card as the client polls it: no step results (fetched on demand), plus what changes every second. */
export interface LiveCard extends CardState {
    elapsed: number;
    activity?: string;
    interrupted?: boolean;
}
/** Rows are saved as text: a title, then the full result, then what the row needs to know that is not for reading. */
export interface RowParts {
    title: string;
    body?: string;
    parentId?: string;
    childId?: string;
    open?: boolean;
    start?: boolean;
    card?: CardState;
}
/** A step's result inside a card; the whole conversation is one click away. */
export declare const MAX_STEP_BODY = 16000;
export declare const cut: (text: string | undefined, limit: number) => string | undefined;
export declare function rowText({ title, body, parentId, childId, open, start, card }: RowParts): string;
export declare function parseRow(text: string): RowParts;
/** The words a card is drawn with, in the goal's language. */
export declare function cardWords(zh: boolean): {
    roleName: (role: Role) => string;
    time: (ms: number) => string;
    step: (role: Role, round: number) => string;
    rounds: (count: number) => string;
    round: (round: number) => string;
    running: (role: Role, round: number) => string;
    /** The line under a running card's title: who is at it, how it went so far, how far it may go. */
    doing: (current: CardStep, sentBackSoFar: number, maxRounds: number) => string;
    tag: (status: StepStatus) => string;
    starting: string;
    interrupted: string;
    interruptedDetail: string;
    title(end: CardEnd): string;
    /** The line under a finished card's title. `last` is the step it stopped at. */
    detail(end: CardEnd, last?: CardStep): string;
    showSteps: (count: number) => string;
    hideSteps: string;
};
/** A running clock: 1:05, or 1:02:05 past an hour. */
export declare function clock(ms: number): string;
export declare function formatTime(ms: number, zh: boolean): string;
