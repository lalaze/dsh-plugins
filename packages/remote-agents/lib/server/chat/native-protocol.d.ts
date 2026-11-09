import { Session } from '@deepseek-ai/dsh-session';
import { type NativeAutonomyBundle } from './native-autonomy.js';
export declare const NATIVE_LIMIT: number;
export declare const FILE_LIMIT: number;
export declare const IMAGE_LIMIT: number;
export declare const ATTACHMENTS_LIMIT: number;
export declare const NATIVE_CLOSED_PROVIDER = "shared-native-closed";
export interface NativeAttachmentRef {
    attachmentId: string;
    bytes: number;
    name?: string;
    mediaType?: string;
    width?: number;
    height?: number;
    originalDimensions?: {
        width: number;
        height: number;
    };
}
/** Kept as `files` on the wire for shared-native-v1 compatibility. */
export interface NativeFile {
    ref: NativeAttachmentRef;
    data: string;
}
export declare const isNativeImage: (ref: NativeAttachmentRef) => boolean;
export declare const nativeAttachmentLimit: (ref: NativeAttachmentRef) => number;
/** Released host event vocabulary is wider than the optional 0.2.1 SDK declaration merge. */
export interface NativeEvent {
    type: string;
    seq: number;
    time: number;
    data: any;
    ignorable?: boolean;
    surfaceOp?: unknown;
    sourceEventSeqs?: readonly number[];
}
export interface NativeSnapshot {
    protocol: 'shared-native-v1';
    header: Session['header'];
    inheritedEventCount: number;
    events: NativeEvent[];
    files: NativeFile[];
    project: string;
    title: string;
    autonomy?: NativeAutonomyBundle;
}
export interface NativeRecord {
    id: string;
    version: number;
    digest: string;
    owner: string | null;
    token: string | null;
    archived: boolean;
    deleted: boolean;
    snapshot: NativeSnapshot;
}
export declare const nativeDigest: (value: unknown) => string;
export interface NativeSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
/** Same pending/last-used fold as the native AgentModel: an unrelated logged
 * request must not retire a newer model selection made while it was running. */
export declare function nativeSelection(events: readonly NativeEvent[]): NativeSelection | undefined;
/** Deliberately conservative first version: no restored autonomous work or path-backed external artifacts. */
export declare function validateNative(snapshot: NativeSnapshot, options?: {
    allowClosed?: boolean;
    treeChild?: boolean;
    allowParked?: boolean;
}): void;
/** Apply the same attachment admission to new messages before model/tool execution. */
export declare function validateNativeInput(messages: unknown[]): void;
/**
 * Inbox insertion precedes pre-step admission. Unsupported, rejected uploads
 * therefore exist in audit-only splice records even though they never reached
 * the model surface. Preserve their envelope/identity and text, replacing only
 * these proven rejected attachment payloads with an explicit local-recovery note.
 * Accepted user/assistant/tool/compaction events are never rewritten.
 */
export declare function portableInboxAudit(events: NativeEvent[], rejected: unknown[]): NativeEvent[];
/** References are discovered throughout raw history, including shadowed compacted nodes and streams. */
export declare function fileRefs(value: unknown): NativeFile['ref'][];
/** Stable ordering keeps version/delta attachment dedup independent of object key order. */
export declare function canonicalRef(ref: NativeAttachmentRef): NativeAttachmentRef;
