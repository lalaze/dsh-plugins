import type { TimelineEntry } from '../core/domain.js';
/**
 * One markdown block of a remote CLI session's saved history: what the user asked, what the CLI answered, and which
 * tools it used. Latest turns win when the history is long; the full record stays in the sessions panel.
 */
export declare function transcript(entries: readonly TimelineEntry[], options: {
    cli: string;
    creator?: string;
}): {
    text: string;
    lastMessageId?: string;
};
