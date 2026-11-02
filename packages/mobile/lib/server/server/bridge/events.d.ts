/**
 * Which session events reach a phone, and in what form. A phone reads and steers, it does not resume the session,
 * so it gets what a person reads (messages, tool calls and results, titles, confirmations) and not what only the
 * model needs: system prompts, request headers, and the token-by-token stream an assistant message contains in full.
 *
 * Adapted from dsh-device-sync's `server/events.ts`.
 */
import type { ModelSelection, PendingInteraction, SyncedEvent } from '../../shared/protocol.js';
import type { HostAttachmentRef, HostEvent } from './host.js';
/** The shared form of one event, or undefined when it stays on its machine. */
export declare function shareEvent(event: HostEvent): SyncedEvent | undefined;
/** A user message DSH added as context rather than one a person sent. */
export declare function isInjected(data: unknown): boolean;
/** Text of the first message a person sent, as DSH's sidebar shows a session without a title. */
export declare function firstPrompt(events: readonly {
    type: string;
    data: unknown;
}[]): string | undefined;
/** Images and files a shared event refers to. */
export declare function attachmentRefs(event: SyncedEvent): HostAttachmentRef[];
/**
 * The model a session uses: its latest `model/selection`, or the model that wrote its latest reply when it never chose
 * one (a session on DSH's default).
 */
export declare function modelOf(events: readonly {
    type: string;
    data: unknown;
}[]): ModelSelection | undefined;
/** Text of the latest assistant message, for a notification. */
export declare function lastAssistantText(events: readonly {
    type: string;
    data: unknown;
}[]): string | undefined;
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
