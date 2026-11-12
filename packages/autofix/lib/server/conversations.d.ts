/** The parts of DSH a task runs on: a conversation in a workspace, and a model flow inside it. */
export interface ModelChoice {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export type FlowRole = 'plan' | 'implement' | 'review';
export interface FlowStep {
    role: FlowRole;
    round: number;
    model: string;
    machine?: string;
    status: string;
    ms?: number;
    childId?: string;
    body?: string;
    note?: string;
}
export type FlowEnd = {
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
    role: FlowRole;
    reason: string;
    ms: number;
} | {
    kind: 'stopped';
    ms: number;
} | {
    kind: 'noVerdict';
    ms: number;
};
export interface FlowResult {
    end: FlowEnd;
    report?: string;
    steps: FlowStep[];
}
/** A flow's card as it is now: what dsh-model-flow 0.1.11 and newer can say while the flow runs. */
export interface FlowProgress {
    steps: FlowStep[];
    rounds: number;
    planned?: boolean;
    zh: boolean;
    elapsed: number;
    activity?: string;
    end?: FlowEnd;
}
export interface FlowRun {
    done: Promise<FlowResult>;
    stop(): void;
    progress?(): FlowProgress;
    stepBody?(index: number): string | undefined;
}
/** `tag` names the flow as this plugin's, so its card in the conversation can carry the task. */
export interface FlowInput {
    goal: string;
    rounds?: number;
    models?: Partial<Record<FlowRole, string>>;
    attachments?: readonly unknown[];
    tag?: string;
}
/** What a task's conversation may do without anyone watching. */
export type Permission = 'workspace-write' | 'auto' | 'danger-full-access';
/** Without `model` the conversation keeps the one DSH gives a new conversation. */
export interface OpenInput {
    path: string;
    title: string;
    model?: ModelChoice;
    permission: Permission;
}
export interface Conversation {
    workspaceId: string;
    sessionId: string;
}
export declare class Conversations {
    private readonly service;
    /** `service` looks a DSH service up by name at the moment it is needed: plugins load in any order. */
    constructor(service: (name: string) => unknown);
    private need;
    /** A new conversation in the workspace at `path` (an existing folder, or a remote workspace's local anchor). */
    open(input: OpenInput): Promise<Conversation>;
    /** A picture into DSH's attachment store. Throws when DSH will not take it (too large, not a picture it reads). */
    picture(image: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }): Promise<unknown>;
    /** A picture DSH keeps, as its bytes: for handing it to another DSH. */
    image(ref: unknown): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    /** Runs a command line in a conversation, as if it had been typed there. */
    command(sessionId: string, line: string): Promise<void>;
    /** Plan, implement and review in that conversation; resolves once the flow has started. */
    flow(sessionId: string, input: FlowInput): Promise<FlowRun>;
}
