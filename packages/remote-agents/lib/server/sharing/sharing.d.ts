import { type ChildProcess } from 'node:child_process';
import { type HostConfig, type NativeProtocol, type Task } from '../core/domain.js';
import { type SshTransport } from '../core/ssh.js';
import type { Store } from '../core/store.js';
import { type ClaudeGoalBridge, type GoalIdentity } from '../chat/claude-goal.js';
/** One stdio MCP server a remote CLI starts: the bridge script in proxy or skills mode. */
export interface SharedServer {
    name: string;
    command: string;
    args: string[];
}
/** What one CLI launch receives. Claude loads `pluginDir` natively; other CLIs get skills as the `dsh` server. */
export interface SharedLaunch {
    pluginDir?: string;
    servers: SharedServer[];
    goalIdentity?: GoalIdentity;
}
export interface LaunchSharing {
    /** Prepare the host for one CLI launch. Never fails the launch: what cannot be shared is left out. */
    prepare(host: HostConfig, transport: SshTransport, task: Task, protocol: NativeProtocol, signal?: AbortSignal): Promise<SharedLaunch>;
    /** A CLI kept running while DSH was away was reattached: its proxies need the reverse forward again. Never throws. */
    attached(host: HostConfig, transport: SshTransport, task: Task): void;
    /** Native CLI session failure; not an MCP operation. */
    goalFailed?(task: Task, messageId: string, reason: string): void;
    /** Prepare the host for a TUI conversation's CLI to lead teams; nothing when AgentTeams is not installed or the host cannot. */
    /** The host was removed: stop sharing with it. */
    forget(hostId: string): void;
}
/**
 * The parts of DSH's tool registry (`ToolRuntime` of `@deepseek-ai/dsh-tools`) and skill registry the bridge uses.
 * This package does not depend on them, so these mirror their signatures.
 */
export interface SharedTool {
    name: string;
    description: string;
    parameters?: unknown;
}
/** An image attachment reference, as DSH content blocks carry it. */
export interface SharedImageRef {
    attachmentId?: string;
    mediaType?: string;
    bytes?: number;
    width?: number;
    height?: number;
}
/** A content block of a settled call; DSH keeps images as attachment references. */
export interface SharedContent {
    type: string;
    text?: string;
    offloaded?: boolean;
    attachment?: SharedImageRef;
}
/** A settled call: `content` is what DSH's post-execute policies left for the model. */
export interface SharedToolResult {
    isError: boolean;
    content: readonly SharedContent[];
}
/** One shared call, as DSH releases before 0.2.2 take it. */
export interface SharedCall {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    agent?: unknown;
    signal: AbortSignal;
}
export interface SharingTools {
    /** Model-facing schemas of the tools visible without an agent scope. */
    schemas(): readonly SharedTool[];
    /**
     * Through DSH's pre-execute policies, approvals, guards and post-execute policies. Before DSH 0.2.2 it takes one
     * call and returns its result; from 0.2.2 it takes `{ calls, agent, signal }` and returns the batch.
     */
    execute(input: any): Promise<any>;
    /** Present from DSH 0.2.2, where `execute` runs a batch. */
    selectExecutor?: unknown;
}
export interface SkillSummary {
    name: string;
    description: string;
    whenToUse?: string;
    path?: string;
    source: string;
    invocation: {
        modelInvocable: boolean;
    };
}
export interface SharingSkills {
    list(options?: {
        signal?: AbortSignal;
    }): Promise<readonly SkillSummary[]>;
    get(name: string, options?: {
        signal?: AbortSignal;
    }): Promise<{
        content: string;
    } | undefined>;
}
/** DSH's attachment store (`AttachmentStore` of `@deepseek-ai/dsh-attachment`): image bytes by reference. */
export interface SharingAttachments {
    readImageRequest(ref: SharedImageRef, target: {
        width: number;
        height: number;
        maxBytes: number;
    }, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
}
export interface SharingHost {
    tools?: SharingTools;
    skills?: SharingSkills;
    attachments?: SharingAttachments;
    agent?(sessionId: string): unknown;
    /** DSH 0.2.2: run work a conversation's CLI asked for as started by that conversation's agent. */
    initiated?<T>(agent: unknown, work: () => Promise<T>): Promise<T>;
    /** Whether the conversation is an AgentTeams member, whose CLI then gets the member tools. */
    teamMember?(sessionId: string): boolean;
}
export interface SharingCatalog {
    /** Whether DSH's tool and skill registries are loaded; without them nothing can be shared. */
    available: {
        mcp: boolean;
        skills: boolean;
    };
    mcp: {
        name: string;
        tools: number;
        shared: boolean;
    }[];
    skills: {
        name: string;
        description: string;
        source: string;
        shared: boolean;
    }[];
}
/** `mcp__<server>__<tool>`: DSH's MCP client names every tool after its configured server. */
export declare function mcpServerOf(name: string): string | undefined;
/**
 * Add the shared servers and skills to a CLI's own launch. Proxies are approved in the CLI, so DSH's permission
 * rules and approval prompts are the only gate: they run with the conversation's DSH agent.
 */
export declare function sharedArguments(protocol: NativeProtocol, launch: string[], shared: SharedLaunch | undefined): string[];
/** ACP's standard stdio declarations for `session/new`, `session/load` and `session/resume`. */
export declare const acpServers: (shared: SharedLaunch | undefined) => {
    name: string;
    command: string;
    args: string[];
    env: {
        name: string;
        value: string;
    }[];
}[];
export declare function bridgeForwardArguments(connection: string, remoteSocket: string, port: number): string[];
/**
 * MCP content for a settled call: DSH's model-facing content, as its post-execute policies left it. Images are read
 * from DSH's attachment store by the reference in that content, so a replaced image is sent as its replacement. An
 * offloaded image, or one that cannot be read, is omitted.
 */
export declare function mcpContent(result: SharedToolResult, attachments?: SharingAttachments, signal?: AbortSignal): Promise<unknown[]>;
/**
 * One call through DSH's tool pipeline, in the form the running DSH takes. DSH 0.2.2 replaced the single typed call
 * with a batch of raw model calls: its `execute` rejects the old form with "Tool batch execution failed". Context a
 * policy or hook adds for the model follows the result as text, since the CLI is the model here.
 */
export declare function executeShared(host: SharingHost, call: SharedCall): Promise<SharedToolResult>;
/**
 * Shares DSH's MCP servers (through DSH, off by default) and skills (copied to the host, on by default) with
 * remote CLIs. MCP calls reach DSH over one reverse-forwarded Unix socket per host and run with the DSH agent of
 * the conversation that owns the CLI, so DSH's permissions, approvals and hooks apply and credentials stay in DSH.
 */
export declare class Sharing implements LaunchSharing {
    private readonly store;
    private readonly launch;
    private readonly log;
    readonly host: SharingHost;
    goals?: ClaudeGoalBridge;
    private server?;
    private listening?;
    private readonly bridges;
    private readonly connections;
    /** Content hashes of skill bundles by file metadata, so unchanged skills are not read again for every launch. */
    private readonly hashes;
    /** Each server's tools as its proxies last listed them, so only real changes are announced. */
    private readonly listed;
    private toolsTimer?;
    private closed;
    constructor(store: Store, launch?: (args: string[]) => ChildProcess, log?: (message: string) => void);
    private settings;
    /** MCP is shared only when switched on; skills unless switched off. */
    mcpShared(server: string): boolean;
    skillShared(name: string): boolean;
    private mcpServers;
    /** The AgentTeams member tools DSH has loaded; captain tools are never shared. */
    private teamTools;
    /**
     * A CLI working as an AgentTeams member gets the member tools without any sharing setting: the team needs them.
     * Only the member's own CLI: one the member delegates to must not claim or report its tasks for it.
     */
    private teamOwner;
    private skillList;
    catalog(signal?: AbortSignal): Promise<SharingCatalog>;
    set(kind: unknown, name: unknown, shared: unknown): Promise<void>;
    /** Ask the CLIs using a server to list its tools again. */
    changed(server?: string): void;
    /** DSH's tools changed, for example once an MCP server connected: the CLIs list the servers whose tools did again. */
    toolsChanged(): void;
    private secret;
    private token;
    private goalOwner;
    /** The conversation whose DSH agent runs the CLI's MCP calls: the main chat, or the agent that delegated it. */
    private owner;
    /** Names this DSH's socket pointer and tool cache on a host: one remote account may be used from several computers. */
    private instance;
    private listen;
    private accept;
    private hello;
    private handle;
    /** The member tools keep their DSH names; AgentTeams itself checks that the calling conversation is a member. */
    private handleTeam;
    private bridge;
    /**
     * Install the bridge script once per version; report the remote home, the absolute Node.js path ACP needs and the
     * synced skills. Checked again after a while, so a deleted ~/.dsh-remote-agents is installed again. Each DSH instance
     * copies its skills to its own directory: another one sharing the remote account may share different skills.
     * A forward that is up is checked too: deleting ~/.dsh-remote-agents takes its socket and pointer with it.
     */
    private install;
    /** A skill bundle's content hash; recomputed only when its files' metadata changed. */
    private hashOf;
    /** Copy the shared skills; unchanged skills are not sent again. */
    private syncSkills;
    /** One reverse-forwarded socket per host; a fresh name each time, since sshd may not unlink a stale one. */
    private ensureForward;
    /** A forward did not start or dropped. Keep one while DSH runs: a reattached CLI may call a shared tool at any time. */
    private ended;
    private schedule;
    /** The host lost a live forward's socket or pointer: end it and bring up another. */
    private replace;
    /** Bring a host's forward up, retrying with backoff until it is. */
    private keep;
    /** Replaced or removed: end the forward and never start another. */
    private stop;
    prepare(host: HostConfig, transport: SshTransport, task: Task, protocol: NativeProtocol, signal?: AbortSignal): Promise<SharedLaunch>;
    goalFailed(task: Task, messageId: string, reason: string): void;
    attached(host: HostConfig, transport: SshTransport, task: Task): void;
    forget(hostId: string): void;
    /** Per-host forward problems, for the settings page. */
    status(): Record<string, string>;
    close(): Promise<void>;
}
