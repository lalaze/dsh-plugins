/**
 * What the phone app and this machine say to each other through the relay, and what the desktop settings page asks
 * the host.
 */
export declare const PROTOCOL = "dsh-mobile/1";
/** The desktop settings page's route, authenticated by DSH's own connection. */
export declare const LOCAL_ROUTE = "/api/dsh-mobile";
/** The phone app, served to browsers already signed in to this DSH, for trying it out before it is hosted elsewhere. */
export declare const APP_ROUTE = "/api/dsh-mobile/app";
/** Its entry page. DSH routes are exact and may not end in `/`, so the app opens at `index.html`. */
export declare const APP_ENTRY = "/api/dsh-mobile/app/index.html";
/** How long a pairing code shown on the desktop stays valid. */
export declare const OFFER_TTL_MS: number;
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
export interface WorkspaceEntry {
    workspaceId: string;
    title: string;
    path: string;
    sessionIds: string[];
    order: number;
}
export interface SessionEntry {
    sessionId: string;
    workspaceId?: string;
    title?: string;
    cwd?: string;
    updatedAt: number;
    /** Latest event sequence this machine knows of. */
    lastSeq: number;
    archived: boolean;
    forkOf?: string;
    parentSessionId?: string;
    origin?: 'subagent';
    state: ExecutionState;
    pending: PendingInteraction[];
    /** The model the session uses, from its latest selection. */
    model?: ModelSelection;
    /** Its permission preset, such as `workspace-write`. */
    permission?: string;
    /** Not started yet; DSH lists such sessions but its sidebar hides them. */
    blank?: boolean;
    /** No longer listed by DSH. */
    removed?: boolean;
}
/** One event of a session log as the phone sees it: DSH's wire event, without the model's token stream. */
export interface SyncedEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
}
export type LiveFrame = {
    type: 'open';
    lastSeq: number;
    entry?: SessionEntry;
} | {
    type: 'event';
    after: number;
    through: number;
    event?: SyncedEvent;
} | {
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
export interface ModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export type PromptPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mediaType: string;
    data: string;
    name?: string;
};
/** A request to run here, identified by `requestId` so a retry never runs twice. */
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
} | {
    kind: 'create';
    requestId: string;
    workspaceId: string;
    content: PromptPart[];
    model?: ModelSelection;
    permission?: string;
} | {
    kind: 'archive';
    requestId: string;
    sessionId: string;
    archived: boolean;
} | {
    kind: 'rename';
    requestId: string;
    sessionId: string;
    title: string;
} | {
    kind: 'model';
    requestId: string;
    sessionId: string;
    model: ModelSelection;
};
export interface CommandResult {
    ok: true;
    sessionId?: string;
}
export interface ModelChoices {
    default?: ModelSelection;
    groups: {
        id: string;
        name: string;
        models: {
            id: string;
            name: string;
            description?: string;
            efforts?: {
                id: string;
                name: string;
            }[];
            defaultEffort?: string;
        }[];
    }[];
    permissions: {
        value: string;
        name: string;
        description?: string;
    }[];
    defaultPermission?: string;
}
/** What a paired phone may do. */
export interface Grants {
    /** Read workspaces and conversations. */
    view: boolean;
    /** Send messages, stop tasks, answer confirmations and start sessions. */
    control: boolean;
}
export declare const DEFAULT_GRANTS: Grants;
/**
 * What the pairing code carries, encoded as base64url JSON after `#pair=` in the app's address. The phone learns this
 * machine's key from it, so a relay or anyone else in the middle cannot pose as this machine.
 */
export interface Offer {
    v: 1;
    /** Relay routing ID of this machine. */
    server: string;
    /** This machine's X25519 public key, base64url. */
    key: string;
    /** Relay `host:port`. */
    relay: string;
    tls: boolean;
    /** One-time secret that lets one phone ask to pair. */
    token: string;
    /** This machine's name, to show while pairing. */
    name: string;
    expires: number;
}
export declare const encodeOffer: (offer: Offer) => string;
export declare function decodeOffer(text: string): Offer;
export declare function base64url(bytes: Uint8Array): string;
export declare function fromBase64url(text: string): Uint8Array<ArrayBuffer>;
/** The six digits both screens show while pairing, from both keys and the token. */
export declare function pairingCode(hubKey: string, phoneKey: string, token: string): Promise<string>;
export interface HubInfo {
    name: string;
    hubId: string;
    version: string;
    /** This phone, once paired. */
    phone?: {
        id: string;
        name: string;
        grants: Grants;
    };
    /** A pairing request from this phone waiting for confirmation on the desktop. */
    pairing?: {
        code: string;
    };
    /** Web Push key, for notifications. */
    pushKey?: string;
}
/** Workspace Tags' tags and which workspaces carry them, as its sidebar shows them. */
export interface TagState {
    tags: {
        id: string;
        name: string;
        color: string;
    }[];
    assignments: Record<string, string[]>;
}
export interface PushSubscriptionJson {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}
export interface PushPreferences {
    finished: boolean;
    attention: boolean;
}
/** Methods a phone may call, with their arguments and results. */
export interface Methods {
    'hub.info': {
        args: undefined;
        result: HubInfo;
    };
    'ping': {
        args: undefined;
        result: {
            ok: true;
        };
    };
    'pair.request': {
        args: {
            token: string;
            name: string;
            platform?: string;
        };
        result: HubInfo;
    };
    'sessions.changes': {
        args: {
            since?: string;
        };
        result: {
            cursor: string;
            sessions: SessionEntry[];
            workspaces?: WorkspaceEntry[];
        };
    };
    'session.events': {
        args: {
            sessionId: string;
            after?: number;
            before?: number;
            limit?: number;
        };
        result: {
            events: SyncedEvent[];
            lastSeq: number;
            hasMore: boolean;
            hasEarlier: boolean;
        };
    };
    'session.live': {
        args: {
            sessionId: string;
        };
        result: undefined;
    };
    'tags': {
        args: undefined;
        result: TagState;
    };
    'command': {
        args: Command;
        result: CommandResult;
    };
    'models': {
        args: {
            workspaceId?: string;
        };
        result: ModelChoices;
    };
    'attachment': {
        args: {
            sessionId: string;
            attachmentId: string;
        };
        result: {
            mediaType: string;
            data: string;
            name?: string;
        };
    };
    'push.subscribe': {
        args: {
            subscription: PushSubscriptionJson;
            preferences: PushPreferences;
        };
        result: {
            ok: true;
        };
    };
    'push.unsubscribe': {
        args: undefined;
        result: {
            ok: true;
        };
    };
    'push.test': {
        args: undefined;
        result: {
            ok: true;
        };
    };
    'cancel': {
        args: {
            id: number;
        };
        result: {
            ok: true;
        };
    };
}
export type Method = keyof Methods;
export type ClientMessage = {
    id: number;
    m: Method;
    a?: unknown;
};
export type HubMessage = {
    id: number;
    r: unknown;
} | {
    id: number;
    e: {
        code: string;
        message: string;
    };
}
/** One frame of a stream such as `session.live`. */
 | {
    id: number;
    f: unknown;
} | {
    id: number;
    end: true;
    e?: {
        code: string;
        message: string;
    };
}
/** Something the phone should fetch again. */
 | {
    n: 'changed';
    cursor: string;
} | {
    n: 'paired';
    info: HubInfo;
} | {
    n: 'unpaired';
    message: string;
};
export type RelayState = 'off' | 'connecting' | 'online' | 'offline';
export interface PhoneStatus {
    id: string;
    name: string;
    platform?: string;
    grants: Grants;
    pairedAt: number;
    lastSeen?: number;
    online: boolean;
    push: boolean;
}
export interface LocalStatus {
    name: string;
    hubId: string;
    relay: {
        state: RelayState;
        endpoint: string;
        error?: string;
        since?: number;
    };
    appUrl: string;
    offer?: {
        url: string;
        expires: number;
    };
    requests: {
        requestId: string;
        name: string;
        platform?: string;
        code: string;
        at: number;
    }[];
    phones: PhoneStatus[];
}
export type LocalAction = {
    action: 'settings';
    relay?: string;
    appUrl?: string;
    name?: string;
} | {
    action: 'offer';
} | {
    action: 'cancelOffer';
} | {
    action: 'confirm';
    requestId: string;
    grants: Grants;
} | {
    action: 'reject';
    requestId: string;
} | {
    action: 'grants';
    phoneId: string;
    grants: Grants;
} | {
    action: 'rename';
    phoneId: string;
    name: string;
} | {
    action: 'unpair';
    phoneId: string;
} | {
    action: 'testPush';
    phoneId: string;
};
