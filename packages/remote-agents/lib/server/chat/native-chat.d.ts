import { createUserMessage, LlmAdapter, ToolCallId, type ContentBlock, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { type DshPermission } from '../core/domain.js';
import { type AttachmentAccess } from '../agents/attachments.js';
import { ChatProjects } from './projects.js';
import { type TeamMember } from './agent-teams.js';
import type { ToolHost } from '../core/dsh-host.js';
import type { WorkspacePlacement } from '../workspace/access.js';
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
/** DSH's PTC executor declares these log-only nested-call events; the chat renders them under their root call. */
interface NestedCall {
    rootCallId: ReturnType<typeof ToolCallId>;
    parentCallId: ReturnType<typeof ToolCallId>;
    subCallId: ReturnType<typeof ToolCallId>;
    name: string;
    arguments: unknown;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'tool/ptc-dispatch-start': NestedCall;
        'tool/ptc-dispatch': NestedCall & {
            isError: boolean;
            content: ContentBlock[];
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
    /** A delegated subagent nobody answers (DSH approval policy `never`): the CLI must not wait for approvals or answers. */
    unattended?(sessionId: NonNullable<GenerateOptions['sessionId']>): boolean;
    /** The AgentTeams team and member this conversation runs as, when it is a team member. */
    teamMember?(sessionId: NonNullable<GenerateOptions['sessionId']>): TeamMember | undefined;
    /** A file from the conversation's verified remote workspace, or undefined when it is too large to show. */
    image?(sessionId: NonNullable<GenerateOptions['sessionId']>, path: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
    /** A file the CLI looked at by absolute path on the conversation's verified machine, inside the workspace or not; undefined when too large. */
    viewedImage?(sessionId: NonNullable<GenerateOptions['sessionId']>, path: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
    attachments?: AttachmentAccess;
}
/** A speed tier (Codex Fast) is a separate picker row: DSH model selections carry only a model and a reasoning effort. */
export declare const chatModelId: (projectId: string, provider: string, model: string, serviceTier?: string) => string;
export declare class RemoteCliAdapter extends LlmAdapter {
    readonly projects: ChatProjects;
    private readonly host;
    private readonly pollMs;
    private readonly lapseMs;
    private active;
    private controllers;
    private released;
    private auxiliaryDirectories;
    private woken;
    constructor(projects: ChatProjects, host: ChatHost, pollMs?: number, lapseMs?: number);
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
    /** Picker metadata and turns without an explicit effort must agree on the effective default. */
    private defaultEffort;
    /** Called when an advertised default effort changes, for the plugin to refresh DSH's model catalog. */
    onModelInfoChange(listener: () => void): () => void;
    /**
     * Plugin unload or DSH shutdown: end local streams but leave remote turns running. A persistent
     * CLI keeps working; the conversation shows its remaining output with the next response.
     */
    close(): void;
    /** The remote task a conversation's model route continues: the same route, or another model of the same CLI. */
    private bound;
    /** The conversation's remote task when its last response ended before all its output reached DSH. */
    private unsynced;
    /**
     * Finished turns of a conversation's CLI session that the conversation never showed, because another DSH sharing the
     * host or Open sessions sent them, after the last turn it showed and before `until`, a message it just sent, and one
     * that is still running. Undefined when there are none, or when the turn the conversation showed last is no longer in
     * the history.
     */
    private elsewhere;
    /**
     * Show turns that another DSH sharing the host, or Open sessions, ran in this conversation's CLI session; one still
     * running streams on as it goes. Like `sync` it wakes the conversation with a notice and sends nothing to the CLI.
     */
    catchUp(agent: SyncAgent): Promise<boolean>;
    /**
     * Wake a conversation whose last remote response was cut off when DSH quit or reloaded the plugin. Its turn
     * streams the output produced meanwhile and waits for the remote turn to finish. Only a conversation still
     * routed to a remote CLI is woken: another model would answer the notice instead. A session continued from
     * another DSH is woken the same way to show its saved history; it has made no request yet, so it has no header.
     */
    sync(agent: SyncAgent): boolean;
    /** A continued session's saved history, read from its start, as one markdown block. */
    private history;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
export {};
