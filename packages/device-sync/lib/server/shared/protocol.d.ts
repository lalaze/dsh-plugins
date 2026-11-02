/**
 * Vocabulary shared by the host and the browser client, and by two paired hosts. Browser-safe: no Node imports.
 *
 * Every session has one executing machine, the one whose DSH owns it. Only that machine appends to the session; a
 * paired machine keeps a read-only copy (a mirror) and sends it requests: prompt, stop, answer. Mirrors never enter
 * DSH's own session store, so nothing synced can make an agent run again.
 */
/** Browser route on each host: GET returns {@link LocalStatus}; POST runs one {@link LocalAction}. */
export declare const LOCAL_ROUTE = "/api/device-sync";
/** Browser route streaming one mirrored session live, as newline-delimited {@link LiveFrame}s. */
export declare const LIVE_ROUTE = "/api/device-sync/live";
/** Browser route serving one mirrored attachment's bytes. */
export declare const ATTACHMENT_ROUTE = "/api/device-sync/attachment";
/** Version of the host-to-host protocol; a peer with another major version is refused. */
export declare const PROTOCOL_VERSION = 1;
/** Default port of the host-to-host listener, bound to this machine's Tailscale address. */
export declare const DEFAULT_PORT = 47630;
/** What one machine allows its paired machine to do. Decided on the machine that enforces it. */
export interface Grants {
    /** Share this machine's workspaces, groups and conversations with the peer. */
    history: boolean;
    /** Let the peer send messages, stop tasks and answer confirmations in this machine's sessions. */
    command: boolean;
}
export declare const DEFAULT_GRANTS: Grants;
export type ExecutionState = 'idle' | 'running' | 'waiting';
/** A confirmation an executing session waits for. */
export type PendingInteraction = {
    kind: 'approval';
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
    askedAt: number;
    answerable: boolean;
} | {
    kind: 'question';
    id: string;
    callId: string;
    questions: Question[];
    askedAt: number;
};
export interface Question {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: {
        label: string;
        description?: string;
    }[];
    multiSelect?: boolean;
}
export interface QuestionAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
/**
 * The SSH directory a remote workspace stands for, as remote-agents (and dsh-remote) records it beside the
 * workspace's local placeholder folder. Two machines whose workspaces have the same binding work on the same project.
 */
export interface RemoteBinding {
    host: string;
    username: string;
    port: number;
    remotePath: string;
    /** The ~/.ssh/config Host the machine was saved as; informative only. */
    alias?: string;
}
/** One workspace as its own machine describes it. Paths are informative only; they are never used on another machine. */
export interface WorkspaceEntry {
    workspaceId: string;
    title: string;
    path: string;
    sessionIds: string[];
    /** Position in that machine's sidebar. */
    order: number;
    /** Set when the workspace is a directory on an SSH machine. */
    remote?: RemoteBinding;
}
/** POSIX normalization as remote-agents applies it: `.` and `..` segments resolve lexically, trailing slashes go. */
export declare function normalizeRemotePath(path: string): string;
/** Whether a binding, possibly from the paired machine, has every field it needs. */
export declare const isRemoteBinding: (value: RemoteBinding | undefined) => value is RemoteBinding;
/**
 * Whether two remote workspaces are the same project: the same host, user, port and directory. Bindings arrive from
 * the paired machine, so anything malformed matches nothing.
 */
export declare function sameRemote(a: RemoteBinding | undefined, b: RemoteBinding | undefined): boolean;
/** A binding as one line, such as `ssh://me@mac-mini:2222/home/me/project`. */
export declare const remoteLabel: (remote: RemoteBinding) => string;
/** The first of `local` that is the same SSH directory as `remote`. */
export declare const matchingWorkspace: (remote: RemoteBinding | undefined, local: readonly WorkspaceEntry[]) => WorkspaceEntry | undefined;
/** One session as its executing machine describes it, without its content. */
export interface SessionEntry {
    sessionId: string;
    workspaceId?: string;
    title?: string;
    cwd?: string;
    updatedAt: number;
    /** Latest event sequence the executing machine knows of; a mirror behind it has events to fetch. */
    lastSeq: number;
    archived: boolean;
    /** Session it was forked from. */
    forkOf?: string;
    /** Parent of a subagent session. */
    parentSessionId?: string;
    origin?: 'subagent';
    state: ExecutionState;
    pending: PendingInteraction[];
    /** No longer listed by the executing machine. Kept as a soft deletion. */
    removed?: boolean;
    /** Session on another machine this one was started to carry on. */
    continuedFrom?: {
        deviceId: string;
        sessionId: string;
    };
}
/** One event of a session log as it is shared: DSH's wire event, with model stream detail and request headers left out. */
export interface SyncedEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
}
/** One frame of a live session stream. */
export type LiveFrame = {
    type: 'open';
    lastSeq: number;
    entry?: SessionEntry;
}
/**
 * One saved event. `after` is the event before it and `through` this one; `event` is absent for events that are
 * not shared. A mirror that does not hold everything through `after` fetches the gap first.
 */
 | {
    type: 'event';
    after: number;
    through: number;
    event?: SyncedEvent;
}
/** Text the assistant is writing, not yet saved. Replaced by an `event` once saved. */
 | {
    type: 'draft';
    attemptId: string;
    text: string;
    reasoning: string;
    done?: boolean;
} | {
    type: 'status';
    entry: SessionEntry;
} | {
    type: 'ping';
} | {
    type: 'error';
    message: string;
};
/** Conflict in data both machines edit: both values are kept until someone picks one. */
export interface GroupConflict {
    key: string;
    /** Human description of the field, e.g. `Tag “Work” name`. */
    label: string;
    kept: unknown;
    other: unknown;
    keptFrom: string;
    otherFrom: string;
    at: number;
}
export interface GroupTag {
    id: string;
    name: string;
    color: string;
    order: number;
}
/** Groups as merged from every machine. */
export interface GroupsView {
    tags: GroupTag[];
    /** Workspace reference (`device:workspace`) → tag ids. */
    assignments: Record<string, string[]>;
    /** Explicit associations between a local and a remote workspace, as pairs of workspace references. */
    links: [string, string][];
    conflicts: GroupConflict[];
    /** Whether dsh-workspace-tags is installed here, so local tags follow the merge. */
    tagsPlugin: boolean;
}
export type PeerConnection = 'online' | 'offline' | 'paused' | 'unpaired';
export interface PeerStatus {
    deviceId: string;
    name: string;
    endpoint: string;
    pairedAt: number;
    connection: PeerConnection;
    /** What this machine allows the peer. */
    grantsToPeer: Grants;
    /** What the peer allows this machine, as it last reported. */
    grantsFromPeer: Grants;
    lastSyncAt?: number;
    lastSeenAt?: number;
    /** Sessions with events still to fetch, plus requests waiting to be sent. */
    pending: number;
    lastError?: string;
    /** Protocol version the peer reported. */
    version?: number;
}
export interface PairingStatus {
    pairingId: string;
    direction: 'incoming' | 'outgoing';
    deviceId: string;
    name: string;
    endpoint: string;
    /** Six digits shown on both machines; equal codes mean nobody is in the middle. */
    code: string;
    confirmedHere: boolean;
    confirmedThere: boolean;
    expiresAt: number;
    grants: Grants;
}
export interface MirrorSessionView extends SessionEntry {
    deviceId: string;
    storedSeq: number;
    /** Hidden here by the user; recoverable. */
    hidden?: boolean;
}
/** A request to the executing machine that waits here. Never sent without the user confirming it again. */
export interface OutboxItem {
    requestId: string;
    deviceId: string;
    sessionId?: string;
    kind: CommandKind;
    summary: string;
    createdAt: number;
    state: 'sending' | 'held' | 'failed';
    error?: string;
}
export interface LocalStatus {
    device: {
        deviceId: string;
        name: string;
    };
    listener: {
        address?: string;
        error?: string;
    };
    peers: PeerStatus[];
    pairings: PairingStatus[];
    workspaces: {
        deviceId: string;
        items: WorkspaceEntry[];
    }[];
    sessions: MirrorSessionView[];
    groups: GroupsView;
    outbox: OutboxItem[];
    backups: {
        name: string;
        at: number;
    }[];
}
export type CommandKind = 'prompt' | 'cancel' | 'approval' | 'answer' | 'create';
export type PromptPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mediaType: string;
    data: string;
    name?: string;
};
/** A request to the executing machine, identified by `requestId` so a retry never runs twice. */
export type Command = {
    kind: 'prompt';
    requestId: string;
    sessionId: string;
    content: PromptPart[];
    mode?: 'queue' | 'steer';
} | {
    kind: 'cancel';
    requestId: string;
    sessionId: string;
} | {
    kind: 'approval';
    requestId: string;
    sessionId: string;
    approvalId: string;
    outcome: 'allowed-once' | 'rejected';
} | {
    kind: 'answer';
    requestId: string;
    sessionId: string;
    callId: string;
    answers: QuestionAnswer[];
}
/** Start a session in one of the executing machine's workspaces. `continuedFrom` links it to the session it carries on. */
 | {
    kind: 'create';
    requestId: string;
    workspaceId: string;
    content: PromptPart[];
    continuedFrom?: {
        deviceId: string;
        sessionId: string;
    };
};
export interface CommandResult {
    ok: true;
    sessionId?: string;
}
export type LocalAction = {
    action: 'pair';
    endpoint: string;
    grants: Grants;
} | {
    action: 'confirmPairing';
    pairingId: string;
    grants?: Grants;
} | {
    action: 'rejectPairing';
    pairingId: string;
} | {
    action: 'setGrants';
    deviceId: string;
    grants: Grants;
} | {
    action: 'pause';
    deviceId: string;
    paused: boolean;
} | {
    action: 'retry';
    deviceId: string;
} | {
    action: 'unpair';
    deviceId: string;
    forgetHistory?: boolean;
} | {
    action: 'rename';
    name: string;
} | {
    action: 'command';
    deviceId: string;
    command: Command;
}
/** Send a held request now, after the user confirmed it again. */
 | {
    action: 'release';
    requestId: string;
} | {
    action: 'discard';
    requestId: string;
} | {
    action: 'hideSession';
    deviceId: string;
    sessionId: string;
    hidden: boolean;
} | {
    action: 'events';
    deviceId: string;
    sessionId: string;
    after?: number;
    limit?: number;
} | {
    action: 'assign';
    workspaceRef: string;
    tagId: string;
    assigned: boolean;
} | {
    action: 'link';
    localRef: string;
    remoteRef: string;
    linked: boolean;
} | {
    action: 'resolveConflict';
    key: string;
    useOther: boolean;
}
/**
 * Start a session in this machine's `workspaceId`, the same SSH directory as a synced session's workspace, with
 * that session's history as context. The synced session is not changed. `requestId` makes a retry harmless.
 */
 | {
    action: 'continueHere';
    requestId: string;
    deviceId: string;
    sessionId: string;
    workspaceId: string;
    note?: string;
};
/** Workspace reference unique across machines. */
export declare const workspaceRef: (deviceId: string, workspaceId: string) => string;
export declare const parseWorkspaceRef: (ref: string) => {
    deviceId: string;
    workspaceId: string;
} | undefined;
