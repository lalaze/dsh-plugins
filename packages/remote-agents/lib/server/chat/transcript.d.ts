import type { TimelineEntry } from '../core/domain.js';
/** Where turns this conversation did not send came from: another DSH by name, Open sessions in this one, or not recorded. */
export type TurnSource = {
    name: string;
} | {
    self: true;
} | undefined;
/** What the chat says at a `model_switch` item, in the language of what the user wrote. */
export declare function modelSwitchNote(item: TimelineEntry['item'], userText: string): string;
/** The line a reply ends with while tools run: the one started last and what it works on, in the language of what the user wrote. */
export declare function toolStatus(running: readonly TimelineEntry['item'][], userText: string): string;
/**
 * One markdown block of a remote CLI session's saved history: what the user asked, what the CLI answered, and which
 * tools it used. Latest turns win when the history is long; the full record stays in the sessions panel.
 * With `elsewhere` the entries are turns sent outside this conversation, headed by where they came from.
 */
export declare function transcript(entries: readonly TimelineEntry[], options: {
    cli: string;
    creator?: string;
    elsewhere?: {
        from: TurnSource;
    };
}): {
    text: string;
    lastMessageId?: string;
};
