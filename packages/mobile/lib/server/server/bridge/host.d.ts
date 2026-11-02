/**
 * The narrow part of DSH this plugin uses, behind one interface so the phone code can be tested without a host.
 * {@link dshHost} adapts DSH 0.2.1-rc.3's services: `sessionController` and `workspaceController` (cold reads, live
 * follow, prompt, cancel, models, archive and rename), `permissionPresets`, `attachments`, `userQuestions`, and the
 * `approval/request` event.
 *
 * Adapted from dsh-device-sync's `server/host.ts`; keep the two in step until they share a package.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelChoices, ModelSelection, QuestionAnswer } from '../../shared/protocol.js';
export interface HostSessionSummary {
    sessionId: string;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    parentSessionId?: string;
    origin?: 'subagent';
    cwd?: string;
    projections?: {
        kind: 'cached' | 'sequenced';
        asOfSeq: number;
        values: Record<string, unknown>;
    };
}
export interface HostEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    [key: string]: unknown;
}
export interface HostInspection {
    meta: {
        id: string;
        createdAt: number;
        cwd?: string;
        parentSession?: string;
        origin?: string;
    };
    events: readonly HostEvent[];
}
export interface HostWorkspace {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: readonly string[];
}
export interface HostWorkspaceState {
    items: HostWorkspace[];
    archivedSessionIds: string[];
}
export type HostFollowFrame = {
    type: 'snapshot';
    cursor: number;
    records: readonly {
        type: 'event';
        event: HostEvent;
    }[];
} | {
    type: 'event';
    event: HostEvent;
} | {
    type: 'assistant-stream';
    frame: {
        type: 'start' | 'chunk' | 'end';
        attemptId: string;
        chunk?: unknown;
        outcome?: {
            kind: string;
        };
    };
};
export type HostPromptPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mediaType: string;
    data: string;
    name?: string;
};
export interface HostImage {
    data: Uint8Array;
    mediaType: string;
}
export interface HostAttachmentRef {
    attachmentId: string;
    kind: 'image' | 'file';
    mediaType?: string;
    name?: string;
    bytes?: number;
    [key: string]: unknown;
}
export interface ApprovalAsk {
    sessionId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}
/**
 * Answers an approval from elsewhere while DSH's own answerers (open browsers) also get the question. `ask`
 * receives each question and returns a promise that settles with a remote answer, or never.
 */
export type ApprovalBridge = (ask: ApprovalAsk, signal: AbortSignal) => {
    answer: Promise<'allowed-once' | 'rejected'>;
    wait: boolean;
} | undefined;
export interface HostApi {
    /** Whether the session services are present yet. */
    ready(): boolean;
    listSessions(signal: AbortSignal): Promise<HostSessionSummary[]>;
    inspect(sessionId: string, signal: AbortSignal): Promise<HostInspection>;
    follow(sessionId: string, signal: AbortSignal): AsyncIterable<HostFollowFrame>;
    prompt(input: {
        sessionId: string;
        requestId: string;
        mode: 'queue' | 'steer';
        content: HostPromptPart[];
    }, signal: AbortSignal): Promise<void>;
    cancel(sessionId: string): void;
    /** Start a session in a workspace, running a permission preset when named. */
    create(workspaceId: string, permission?: string): Promise<string>;
    /** Models and permission presets a new session can use. */
    modelChoices(): Promise<ModelChoices>;
    selectModel(sessionId: string, model: ModelSelection): Promise<void>;
    archive(sessionId: string, archived: boolean): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    answerQuestion(sessionId: string, callId: string, answers: QuestionAnswer[]): Promise<boolean>;
    /** Open questions per session, from DSH's `userQuestions` projection. */
    questions(signal: AbortSignal): AsyncIterable<{
        sessionId: string;
        active: unknown;
    }>;
    workspaces(signal: AbortSignal): AsyncIterable<HostWorkspaceState>;
    readImage(ref: HostAttachmentRef, signal: AbortSignal): Promise<HostImage>;
    readFile(ref: HostAttachmentRef, signal: AbortSignal): AsyncIterable<Uint8Array>;
    /** Session list changes: an added, removed, or started or stopped session. */
    onSessionChange(listener: (sessionId: string) => void): () => void;
    /** Route approval questions through `bridge`; DSH keeps asking its own answerers too. */
    bridgeApprovals(bridge: ApprovalBridge): () => void;
}
/** Adapt the running DSH host. Services are looked up on each call, so they may arrive after this plugin. */
export declare function dshHost(ctx: Context): HostApi;
/**
 * Take part in DSH's `approval/request` waterfall without taking it over.
 *
 * The waterfall passes one request object along the chain, so a listener cannot give the answerers after it a
 * different cancellation signal. To withdraw the question from open browsers when another machine answers first,
 * this listener runs the chain again itself with a copy of the request whose signal it controls, and marks the copy
 * so it passes straight through when it reaches this listener. Any failure falls back to the unchanged chain.
 */
export declare function bridgeApprovalEvent(ctx: Context, bridge: ApprovalBridge): () => void;
