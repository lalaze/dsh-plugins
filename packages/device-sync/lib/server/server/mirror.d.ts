import type { MirrorSessionView, SessionEntry, SyncedEvent, WorkspaceEntry } from '../shared/protocol.js';
export interface AttachmentMeta {
    kind: 'image' | 'file';
    mediaType?: string;
    name?: string;
    bytes?: number;
    sha256?: string;
}
/** `storedSeq` is the last event held, or -1 before the first. */
interface MirrorSession extends SessionEntry {
    storedSeq: number;
    hidden?: boolean;
    localTitle?: string;
    attachments?: Record<string, AttachmentMeta>;
}
interface MirrorIndex {
    version: 1;
    cursor?: string;
    workspaces: WorkspaceEntry[];
    sessions: Record<string, MirrorSession>;
}
export declare class Mirror {
    readonly deviceId: string;
    private readonly dir;
    private index;
    private readonly serial;
    constructor(deviceId: string, dir: string);
    load(): Promise<void>;
    private save;
    get cursor(): string | undefined;
    workspaces(): WorkspaceEntry[];
    /** Apply one changes response, then remember its cursor. */
    update(changes: {
        cursor: string;
        workspaces?: WorkspaceEntry[];
        sessions: SessionEntry[];
    }): Promise<void>;
    /** Replace one entry's live status without touching its stored events. */
    status(entry: SessionEntry): Promise<void>;
    session(sessionId: string): MirrorSession | undefined;
    /** Sessions whose executing machine has events this copy lacks. */
    behind(): MirrorSession[];
    views(): MirrorSessionView[];
    /**
     * Store events after the stored position; everything through `through` counts as held afterwards.
     * @returns the events that were new.
     */
    append(sessionId: string, events: readonly SyncedEvent[], through: number, attachments?: Record<string, AttachmentMeta>): Promise<SyncedEvent[]>;
    /** Stored events in order, each sequence once, optionally after a position and up to a count from the end. */
    read(sessionId: string, options?: {
        after?: number;
        last?: number;
    }): Promise<SyncedEvent[]>;
    attachment(sessionId: string, attachmentId: string): AttachmentMeta | undefined;
    setAttachment(sessionId: string, attachmentId: string, meta: AttachmentMeta): Promise<void>;
    /** Hide a session here, or show it again. Nothing is deleted. */
    hide(sessionId: string, hidden: boolean): Promise<void>;
    /** Everything this copy stores, for a backup. */
    snapshot(): MirrorIndex;
    /** Delete the copy entirely, after the user chose to forget a machine's history. */
    destroy(): Promise<void>;
    private logPath;
}
/** Attachment bytes stored by SHA-256, shared by every mirror. */
export declare class Blobs {
    private readonly dir;
    constructor(dir: string);
    path(sha256: string): string;
    has(sha256: string): Promise<boolean>;
    put(data: Uint8Array): Promise<string>;
    get(sha256: string): Promise<Buffer>;
    count(): Promise<number>;
}
export declare function ensureDir(path: string): Promise<void>;
export {};
