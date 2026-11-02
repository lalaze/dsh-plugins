import { type LiveFrame, type LocalAction, type LocalStatus } from '../shared/protocol.js';
import { Executor } from './executor.js';
import { Groups, type TagState } from './groups.js';
import type { HostApi } from './host.js';
import { type Identity } from './identity.js';
import { type InboundRequest, type InboundResult } from './transport.js';
/** dsh-workspace-tags' host service (0.1.10 and later). */
export interface WorkspaceTagsService {
    snapshot(): TagState;
    replace(state: TagState): Promise<TagState>;
    subscribe(listener: (state: TagState) => void): () => void;
}
export interface ListenOptions {
    /** Address to bind; this machine's Tailscale IPv4 address when omitted. */
    host?: string;
    port: number;
    /** Address paired machines use to reach this one; `host:port` when omitted. */
    advertise?: string;
    /** Accept peers from outside Tailscale and loopback. */
    anyNetwork?: boolean;
}
export interface ServiceOptions {
    stateDir: string;
    host: HostApi;
    tags?: () => WorkspaceTagsService | undefined;
    listen: ListenOptions;
    /** Pull interval while a peer is online. */
    intervalMs?: number;
    /** Images up to this size are fetched with their session; larger attachments when first opened. */
    autoDownloadBytes?: number;
    /** DSH's home directory, where remote workspaces record which SSH directory they stand for. */
    dshHome?: string;
    log?(message: string): void;
}
export declare class HttpError extends Error {
    readonly status: number;
    name: string;
    constructor(message: string, status?: number);
}
/** This machine's Tailscale IPv4 address, if Tailscale is connected. */
export declare function tailscaleAddress(): string | undefined;
export declare class DeviceSync {
    private readonly options;
    readonly identity: Identity;
    private readonly state;
    private readonly serial;
    private saveTimer?;
    private readonly links;
    private readonly mirrors;
    private readonly blobs;
    private readonly controller;
    private server?;
    private listenAddress?;
    private listenError?;
    private notifyTimer?;
    private applyingTags;
    private tagsUnsubscribe?;
    private tagsService?;
    private readonly attachmentHashes;
    readonly executor: Executor;
    readonly groups: Groups;
    private constructor();
    static open(options: ServiceOptions): Promise<DeviceSync>;
    private log;
    /** Persist soon; writes are serialized and coalesced. */
    private save;
    private flush;
    private mirror;
    private active;
    private link;
    private interval;
    private endpoint;
    start(): Promise<void>;
    close(): Promise<void>;
    /** Bind the peer listener to the Tailscale address, and rebind when the address appears or changes. */
    private listenLoop;
    /** Follow dsh-workspace-tags once it is there: its edits become group changes, merged groups are written back. */
    private tagsLoop;
    private observeTags;
    private groupsRev;
    private projectTags;
    /**
     * Only this machine's workspaces, or those of a paired machine this one shares with, take groups: that machine
     * pulls the change from here, so without sharing it never arrives. Paused or offline machines get it later.
     */
    private assignable;
    /** A local group edit that is not in dsh-workspace-tags (another machine's workspace, or a link). */
    private groupsChanged;
    private schedule;
    /** Fetch everything that changed on one paired machine. Never throws: failures are shown and retried later. */
    pull(deviceId: string): Promise<void>;
    private request;
    private pullOnce;
    /** Fetch a session's events after the stored position, in pages, until caught up. */
    private pullEvents;
    /** Fetch one attachment unless its content is already stored, possibly for another session. */
    private fetchAttachment;
    /** Tell paired machines to pull soon. */
    private notifyPeers;
    /** Copy what a first sync could change before it runs: tags, this plugin's state, and mirror indexes. */
    private backup;
    private backups;
    private keyFor;
    private pairingView;
    private prunePairings;
    /** Ask the machine at `endpoint` to pair. Both users then compare the code and confirm on their own machine. */
    private pair;
    private confirmPairing;
    private settleOutgoing;
    /** After confirming here, wait for the other user to confirm there. */
    private waitForOtherSide;
    private activate;
    private unpair;
    private forget;
    private sendCommand;
    private summary;
    /**
     * Send a request to the machine that executes the session. When that machine is offline the request is held, and
     * sent only once the user confirms it again; it is never run on this machine instead.
     */
    private command;
    private deliver;
    private outboxView;
    /**
     * Start a session here that carries on a synced one, in this machine's workspace for the same SSH directory. It
     * runs only here, so the other machine, which may well be off, is neither asked nor changed.
     */
    private continueHere;
    status(): Promise<LocalStatus>;
    action(input: LocalAction): Promise<unknown>;
    private requirePeer;
    /** Follow a mirrored session live, storing its events here as they arrive. */
    live(deviceId: string, sessionId: string, signal: AbortSignal): AsyncIterable<LiveFrame>;
    /** An attachment of a mirrored session: from local storage, or fetched from its machine the first time. */
    attachment(deviceId: string, sessionId: string, attachmentId: string): Promise<{
        data: Buffer;
        mediaType: string;
        name?: string;
    }>;
    handlePeer(request: InboundRequest): Promise<InboundResult>;
    private routePeer;
    private incomingPairing;
    private pairingAnswer;
}
