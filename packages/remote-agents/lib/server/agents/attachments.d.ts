import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import { type Attachment, type NativeAttachment } from '../core/domain.js';
import type { SshTransport } from '../core/ssh.js';
export interface AttachmentAccess {
    image(ref: ImageBlock['attachment'], signal?: AbortSignal): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    file(ref: FileBlock['attachment'], signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
export declare const attachmentDirectory: (directory: string, taskId: string, messageId: string) => string;
/** The LLM runtime projects files to text; recover only the session's authorized file blocks. */
export declare function restoreFiles(content: readonly ContentBlock[], original?: readonly ContentBlock[]): readonly ContentBlock[];
/** Stream files to private local staging; only bounded request-image versions are buffered. */
export declare function stageAttachments(directory: string, taskId: string, messageId: string, blocks: readonly ContentBlock[], access?: AttachmentAccess, signal?: AbortSignal): Promise<Attachment[]>;
/**
 * DSH Desktop cites dropped or picked non-image files as absolute `@path` mentions instead of uploading them.
 * Those paths name the DSH machine; paths inside the remote workspace stay for the CLI to read itself.
 */
export declare function localFileMentions(text: string, remoteCwd: string): string[];
export interface LocalFile {
    path: string;
    attachment: Attachment;
}
/** Stage the mentioned files that exist on this machine; anything else is left for the remote CLI. */
export declare function stageLocalFiles(directory: string, taskId: string, messageId: string, paths: readonly string[], signal?: AbortSignal): Promise<LocalFile[]>;
/** Point each staged mention at its uploaded copy, relative to the remote CLI's working directory. */
export declare function localFilePrompt(text: string, taskId: string, messageId: string, files: readonly LocalFile[]): string;
/** Scope remote copies to one task/message; display names never select directories. */
export declare function attachmentRelativePath(taskId: string, messageId: string, attachment: Attachment): string;
export declare function transferAttachments(transport: SshTransport, directory: string, taskId: string, messageId: string, cwd: string, attachments: readonly Attachment[], signal?: AbortSignal): Promise<NativeAttachment[]>;
export declare function attachmentPrompt(text: string, attachments: readonly NativeAttachment[]): string;
