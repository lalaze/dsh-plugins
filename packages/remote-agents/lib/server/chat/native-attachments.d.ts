import { type NativeFile } from './native-protocol.js';
/** Only public AttachmentStore and the audited local provider publication API.
 * No path supplied by a peer becomes a filesystem destination. */
export declare function exportNativeAttachments(store: any, events: unknown): Promise<NativeFile[]>;
export declare function importNativeAttachments(store: any, files: readonly NativeFile[], load: (name: string) => Promise<any>): Promise<void>;
