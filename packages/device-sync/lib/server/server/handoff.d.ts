/**
 * The first message of a session that carries on a synced one here: the synced session's conversation as plain text,
 * so a model on this machine can pick it up. Tool calls keep only their names; their arguments and results are what
 * a model can read again from the workspace itself.
 */
import type { SyncedEvent } from '../shared/protocol.js';
export declare const MAX_NOTE = 20000;
interface Entry {
    role: 'user' | 'assistant';
    text: string;
    tools: string[];
}
/** User and assistant turns in order; consecutive assistant messages form one entry. */
export declare function conversationEntries(events: readonly SyncedEvent[]): Entry[];
/**
 * The whole first message, at most `limit` characters: a short introduction, the most recent part of the
 * conversation that fits, and what to do next.
 */
export declare function handoffPrompt(events: readonly SyncedEvent[], source: {
    title?: string;
    machine: string;
    workspace: string;
    note?: string;
}, limit: number): string;
export {};
