import { createUserMessage, LlmAdapter, type ContentBlock, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { type DshPermission } from './domain.js';
import { type AttachmentAccess } from './attachments.js';
import { ChatProjects } from './chat-projects.js';
import { type ToolHost } from './tools.js';
import type { WorkspacePlacement } from './workspace-access.js';
export declare const CHAT_PROVIDER = "remote-cli";
/** Wakes a conversation whose remote turn outlived DSH, so the missed output streams in without a new message. */
export declare const SYNC_SOURCE = "remote-cli-sync";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'remote-cli-sync': {
            readonly kind: 'remote-cli-sync';
            readonly form: 'notice';
            readonly summary: string;
        };
    }
}
/** The parts of a live DSH agent that a catch-up wake needs. */
export interface SyncAgent {
    readonly session: Pick<Session, 'id' | 'requestHeader'>;
    send(message: ReturnType<typeof createUserMessage>, target: 'next-turn', wakeup: boolean): void;
}
export declare const chatProviderId: (cli: string) => string;
/** The old aggregate route stays resolvable for saved conversations, with an empty picker catalog. */
export declare const CHAT_PROVIDERS: string[];
export interface ChatHost extends Partial<ToolHost> {
    agent(sessionId: NonNullable<GenerateOptions['sessionId']>): unknown;
    cwd?(sessionId: NonNullable<GenerateOptions['sessionId']>): string | undefined;
    workspace?(cwd: string, signal?: AbortSignal): Promise<WorkspacePlacement>;
    step(sessionId: NonNullable<GenerateOptions['sessionId']>): {
        session: Session;
        turn: number;
        step: number;
    } | undefined;
    userContent?(sessionId: NonNullable<GenerateOptions['sessionId']>, messageId: string): readonly ContentBlock[] | undefined;
    /** The conversation's permission from the DSH composer; undefined for a custom value or without permission presets. */
    permission?(sessionId: NonNullable<GenerateOptions['sessionId']>): DshPermission | undefined;
    /** A file from the conversation's verified remote workspace, or undefined when it is too large to show. */
    image?(sessionId: NonNullable<GenerateOptions['sessionId']>, path: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
    attachments?: AttachmentAccess;
}
/** A speed tier (Codex Fast) is a separate picker row: DSH model selections carry only a model and a reasoning effort. */
export declare const chatModelId: (projectId: string, provider: string, model: string, serviceTier?: string) => string;
export declare class RemoteCliAdapter extends LlmAdapter {
    readonly projects: ChatProjects;
    private readonly host;
    private readonly pollMs;
    private active;
    private controllers;
    private released;
    private auxiliaryDirectories;
    private modelInfoListeners;
    private woken;
    constructor(projects: ChatProjects, host: ChatHost, pollMs?: number);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    providerRetryPolicy(): {
        mode: "normal";
        maxRetries: number;
        retryableCodes: never[];
        initialDelayMs: number;
        maxDelayMs: number;
        jitterRatio: number;
    };
    listModels(provider: string): Promise<LlmModelInfo[]>;
    private route;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** Called when an advertised default effort changes, for the plugin to refresh DSH's model catalog. */
    onModelInfoChange(listener: () => void): () => void;
    /** Remember the effort a conversation turn uses with a model; compaction's disposable sessions do not count. */
    private rememberEffort;
    /**
     * Plugin unload or DSH shutdown: end local streams but leave remote turns running. A persistent
     * CLI keeps working; the conversation shows its remaining output with the next response.
     */
    close(): void;
    /** The conversation's remote task when its last response ended before all its output reached DSH. */
    private unsynced;
    /**
     * Wake a conversation whose last remote response was cut off when DSH quit or reloaded the plugin. Its turn
     * streams the output produced meanwhile and waits for the remote turn to finish. Only a conversation still
     * routed to a remote CLI is woken: another model would answer the notice instead.
     */
    sync(agent: SyncAgent): boolean;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
