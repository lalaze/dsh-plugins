/** Browser-safe types. SSH configuration and native CLI argv stay on the DSH server. */
export interface Host {
    id: string;
    label: string;
    connection: string;
    serverId?: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    modelCount?: number;
    modelError?: string;
    modelsCheckedAt?: string;
    providerErrors?: {
        label: string;
        error: string;
    }[];
    enabledProviders?: string[];
    /** Sessions and workspaces are shared with every DSH connected to this SSH account. On unless switched off. */
    share: boolean;
    /** Why the shared session registry is unavailable, while sharing is on. */
    shareError?: string;
}
export interface HostCatalog {
    cwd: string;
    providers: Provider[];
    checkedAt: string;
}
/** `share: false` keeps this host's sessions to this DSH; any other value shares them. */
export interface HostConfig {
    id: string;
    label: string;
    connection: string;
    password?: string;
    serverId?: string;
    catalog?: HostCatalog;
    modelError?: string;
    enabledProviders?: string[];
    share?: boolean;
}
export declare const sharesSessions: (host: Pick<HostConfig, "share">) => boolean;
export interface SshConfigHost {
    alias: string;
    connection: string;
}
export interface SshConfigHosts {
    hosts: SshConfigHost[];
    warnings: string[];
}
export interface Choice {
    id: string;
    label: string;
    isDefault?: boolean;
}
/** Keep new Claude modes selectable in catalogs and sessions saved before an upgrade. */
export declare function permissionModes(provider: string, modes: Choice[]): Choice[];
/** The DSH conversation's permission, as its preset's sandbox mode or `auto` for Auto review. */
export type DshPermission = 'read-only' | 'workspace-write' | 'danger-full-access' | 'auto';
/** The CLI mode matching a DSH permission, when the CLI and its catalog offer one. */
export declare function presetMode(provider: string, modes: Choice[], permission: DshPermission | undefined): string | undefined;
/** `serviceTiers` are Codex speed tiers (for example Fast); without one the CLI's configured tier applies. */
export interface Model extends Choice {
    thinkingOptions?: Choice[];
    defaultThinkingOptionId?: string;
    serviceTiers?: Choice[];
    inputModalities?: ('text' | 'image')[];
}
/** The tier the Fast switch selects: Codex names it `priority` or `fast`; otherwise the model's only extra tier. */
export declare const fastTierOf: (model: Pick<Model, "serviceTiers">) => Choice | undefined;
export interface Provider {
    id: string;
    label: string;
    status: 'loading' | 'ready' | 'unavailable' | 'error';
    error?: string;
    notice?: string;
    models: Model[];
    modes: Choice[];
    defaultModeId?: string | null;
}
export interface Cursor {
    epoch: string;
    seq: number;
}
/** Relay output already reflected in the history: resume at byte `at`; `partial` restores Claude's streaming state. */
export interface RelayPosition {
    id: string;
    at: number;
    partial?: true;
}
export interface TimelineEntry {
    seqStart: number;
    seqEnd: number;
    timestamp: string;
    turnId?: string;
    item: Record<string, unknown> & {
        type: string;
    };
    relay?: RelayPosition;
}
export interface TimelinePage {
    epoch: string;
    reset: boolean;
    staleCursor: boolean;
    gap: boolean;
    entries: TimelineEntry[];
    startCursor: Cursor | null;
    endCursor: Cursor | null;
    hasOlder: boolean;
    hasNewer: boolean;
}
/** A single submitted message's output, bounded by the next user message. */
export interface MessageTimeline extends TimelinePage {
    found: boolean;
    deliveryConfirmed: boolean;
    hasFollowingMessage: boolean;
    terminalStatus?: string;
}
export interface ChatProject {
    id: string;
    label: string;
    hostId: string;
    cwd: string;
    providers: Provider[];
}
export interface Permission {
    id: string;
    name: string;
    kind: string;
    title?: string;
    description?: string;
    input?: Record<string, unknown>;
    detail?: unknown;
    actions?: {
        id: string;
        label: string;
        behavior: 'allow' | 'deny';
        scope?: 'once' | 'session' | 'project';
    }[];
}
export interface PermissionAnswer {
    behavior: 'allow' | 'deny';
    selectedActionId?: string;
    answers?: Record<string, string>;
    message?: string;
}
/** Tokens one CLI turn consumed, in DSH's `TokenUsage` shape: input excludes cache reads and writes; reasoning is part of output. */
export interface TurnUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
}
/** A finished turn: when it started, whether it failed and, when the CLI named it, the model that ran rather than the picker's alias. */
export interface FinishedTurn {
    startedAt: string | null;
    failed: boolean;
    model?: string;
}
/** Tokens held in one native session's context window. */
export interface ContextUsage {
    used: number;
    max: number;
}
/** Input includes cache reads and writes. Missing counters mean unreported, not zero. */
export interface TokenUsageBreakdown {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
}
/** Native model-request usage. Only Codex supplies a cumulative thread total. */
export interface TokenUsage {
    last?: TokenUsageBreakdown;
    total?: TokenUsageBreakdown;
}
/** One plan rate-limit window of a CLI account; `label` is English and localized by the client. */
export interface QuotaWindow {
    id: string;
    label: string;
    usedPercent: number;
    resetsAt?: string;
}
/** Plan limits of the account a CLI is signed in with on an SSH host, as that CLI reports them. */
export interface AccountUsage {
    provider: string;
    plan?: string;
    email?: string;
    windows: QuotaWindow[];
    extraUsage?: boolean;
    credits?: string;
    checkedAt: string;
    error?: string;
}
/** What the composer usage ring shows for a DSH conversation bound to a remote CLI. */
export interface UsageReport {
    provider: string;
    context: ContextUsage | null;
    tokenUsage?: TokenUsage;
    account?: AccountUsage;
}
/** Live state of one attached (or detached) native CLI session. */
export interface Agent {
    id: string;
    cwd: string;
    provider: string;
    model: string | null;
    title: string | null;
    status: string;
    activeTurn?: {
        turnId: string;
        startedAt: string | null;
    } | null;
    pendingPermissions: Permission[];
    lastError?: string;
    nativeSessionId?: string | null;
    resumable?: boolean;
    context?: ContextUsage;
    tokenUsage?: TokenUsage;
    /** The CLI runs under a relay on the SSH host and survives DSH restarts and SSH interruptions. */
    persistent?: boolean;
    /** A persistent CLI whose SSH connection is being re-established. */
    reconnecting?: boolean;
}
/** Why a host cannot run CLIs under a relay. */
export type RelayUnavailable = 'missing-node' | 'old-node' | 'install-failed';
/** A CLI is never started without a relay, because it would end silently with DSH. */
export declare const RELAY_UNAVAILABLE: Readonly<Record<RelayUnavailable, string>>;
export interface TaskInput {
    id: string;
    hostId: string;
    cwd: string;
    provider: string;
    model: string;
    modeId?: string;
    thinkingOptionId?: string;
    serviceTier?: string;
    prompt: string;
    attachments?: Attachment[];
}
/** Staged, content-addressed bytes. No host filesystem paths or base64 enter the registry. */
export interface Attachment {
    sha256: string;
    name: string;
    bytes: number;
    kind: 'image' | 'file';
    mediaType?: string;
}
export interface NativeAttachment extends Attachment {
    path: string;
    data?: string;
}
export declare const inputModalitiesOf: (provider: string, model: Model) => ("text" | "image")[];
/** Durable agent record. `id` is the client request ID, so retried creation is idempotent. */
export interface Task extends TaskInput {
    /** Native DSH conversation binding, independent of background delegation. */
    chat?: {
        sessionId: string;
        route: string;
        receiptRoute?: string;
        lastUserId?: string;
        /** How much of a message's output reached the DSH conversation; the rest is shown with the next response. */
        delivered?: {
            messageId: string;
            cursor: Cursor | null;
            done?: true;
        };
    };
    serverId: string;
    title: string;
    createdAt: string;
    updatedAt?: string;
    /** Mode choices discovered when the agent was created; mode changes are validated against them. */
    modes?: Choice[];
    archived?: boolean;
    /** Started by the DSH agent through a delegation tool. */
    origin?: 'dsh';
    /** The DSH conversation whose agent delegated this task; it runs the task's shared MCP calls. */
    owner?: {
        sessionId: string;
    };
    agentId?: string;
    executionCwd?: string;
    native?: {
        protocol: NativeProtocol;
        sessionId: string;
        argv: string[];
        resumable?: boolean;
        initialSent: boolean;
        imageInput?: boolean;
    };
    /** A relay that may still run this task's CLI on the SSH host; restored after DSH restarts. */
    relay?: {
        id: string;
    };
    /** Last reported context window fill, kept for a detached session. */
    context?: ContextUsage;
    /** Latest native token counters, kept across detach and restart. */
    tokenUsage?: TokenUsage;
    /** The shared record revision this copy matches. `imported` copies were started by another DSH, named by `creator`. */
    shared?: {
        rev: number;
        creator?: string;
        imported?: true;
    };
    state: 'creating' | 'ready' | 'uncertain';
    error?: string;
}
export type NativeProtocol = 'codex' | 'claude' | 'acp' | 'antigravity';
export declare const PROVIDER_LABELS: Readonly<Record<string, string>>;
/** Older machines retain their providers until the user explicitly changes the selection. */
export declare const enabledProvidersOf: (host: Pick<HostConfig, "enabledProviders">) => string[];
export declare function providerSelection(value: unknown): string[];
/** `attention` means a permission request or question is waiting for the user. */
export type AgentStatus = 'starting' | 'running' | 'attention' | 'idle' | 'error' | 'closed';
export interface AgentSummary {
    id: string;
    /** Open bound conversations in the native DSH UI; never submit a second conversation here. */
    chatSessionId?: string;
    hostId: string;
    cwd: string;
    provider: string;
    model: string;
    modeId?: string;
    thinkingOptionId?: string;
    serviceTier?: string;
    modes: Choice[];
    title: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    delegated: boolean;
    /** The native CLI session was created; messages can be sent (resuming it when needed). */
    started: boolean;
    /** Whether the CLI process is currently attached; an idle resumable agent can be detached. */
    attached: boolean;
    status: AgentStatus;
    pendingPermissions: number;
    error?: string;
    resumable?: boolean;
    nativeSessionId?: string;
    persistent?: boolean;
    reconnecting?: boolean;
    /** The DSH that started a shared session, when it was another one. */
    creator?: string;
    /** Another DSH drives this shared session's CLI; sending, answering or stopping here takes it over. */
    controller?: string;
}
export interface AgentState {
    agent: AgentSummary;
    permissions: Permission[];
}
export interface AgentDetail extends AgentState {
    timeline: TimelinePage | null;
}
export interface Dashboard {
    hosts: Host[];
    agents: AgentSummary[];
}
/** One remote directory level: `path` is canonical; `entries` lists subdirectories only. */
export interface DirectoryListing {
    path: string;
    home: string;
    entries: {
        name: string;
        path: string;
    }[];
    truncated: boolean;
}
/** A remote directory adopted as a DSH workspace through its local anchor folder. */
export interface RemoteWorkspace {
    hostId: string;
    path: string;
    remotePath: string;
}
export declare const busy: (agent: Pick<AgentSummary, "status">) => boolean;
export declare class RemoteError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function field(value: unknown, label: string, max?: number): string;
export declare function identifier(value: unknown): string;
export declare function remotePath(value: unknown): string;
/** An absolute remote path, or one under the remote home written as `~` or `~/…`. */
export declare function browsePath(value: unknown): string;
export declare function taskInput(value: unknown): TaskInput;
export declare function attachmentInput(value: unknown): Attachment[];
export declare function cursorInput(value: unknown): Cursor | undefined;
export interface Question {
    header: string;
    question: string;
    options: {
        label: string;
        description?: string;
    }[];
    multiple: boolean;
    freeText: boolean;
    optional: boolean;
}
export declare function questionsOf(input: Record<string, unknown> | undefined): Question[];
