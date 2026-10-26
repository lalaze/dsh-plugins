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
}
export interface HostCatalog {
    cwd: string;
    providers: Provider[];
    checkedAt: string;
}
export interface HostConfig {
    id: string;
    label: string;
    connection: string;
    password?: string;
    serverId?: string;
    catalog?: HostCatalog;
    modelError?: string;
    enabledProviders?: string[];
}
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
/** Older saved Claude catalogs also need a way to return to the remote CLI's settings. */
export declare function permissionModes(provider: string, modes: Choice[]): Choice[];
export interface Model extends Choice {
    thinkingOptions?: Choice[];
    defaultThinkingOptionId?: string;
    inputModalities?: ('text' | 'image')[];
}
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
export interface TimelineEntry {
    seqStart: number;
    seqEnd: number;
    timestamp: string;
    turnId?: string;
    item: Record<string, unknown> & {
        type: string;
    };
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
}
export interface TaskInput {
    id: string;
    hostId: string;
    cwd: string;
    provider: string;
    model: string;
    modeId?: string;
    thinkingOptionId?: string;
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
    agentId?: string;
    executionCwd?: string;
    native?: {
        protocol: NativeProtocol;
        sessionId: string;
        argv: string[];
        resumable?: boolean;
        initialSent: boolean;
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
export declare const busy: (agent: Pick<AgentSummary, "status">) => boolean;
export declare class RemoteError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function field(value: unknown, label: string, max?: number): string;
export declare function identifier(value: unknown): string;
export declare function remotePath(value: unknown): string;
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
