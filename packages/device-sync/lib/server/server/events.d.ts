/**
 * Which session events leave the executing machine, and in what form. A mirror is for reading and steering, not for
 * resuming the session, so it keeps what a person reads (messages, tool calls and results, titles, confirmations)
 * and leaves out what only the model needs: system prompts, request headers, and the token-by-token stream that
 * an assistant message already contains in full.
 */
import type { PendingInteraction, SyncedEvent } from '../shared/protocol.js';
import type { HostAttachmentRef, HostEvent } from './host.js';
/** The shared form of one event, or undefined when it stays on its machine. */
export declare function shareEvent(event: HostEvent): SyncedEvent | undefined;
/** Images and files a shared event refers to. */
export declare function attachmentRefs(event: SyncedEvent): HostAttachmentRef[];
/** Latest title in a log. */
export declare function titleOf(events: readonly {
    type: string;
    data: unknown;
}[]): string | undefined;
/** Approvals asked in a log and not yet decided. They show as waiting even when this plugin cannot answer them. */
export declare function openApprovals(events: readonly {
    type: string;
    time: number;
    data: unknown;
}[]): PendingInteraction[];
/** DSH `userQuestions.active` entries still open, in the shared form. */
export declare function openQuestions(active: unknown, now?: number): PendingInteraction[];
/** Text of an assistant stream chunk, by kind. */
export declare function chunkText(chunk: unknown): {
    text?: string;
    reasoning?: string;
};
