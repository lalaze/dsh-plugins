import { type TimelineEntry } from '../core/domain.js';
/** Where turns this conversation did not send came from: another DSH by name, Open sessions in this one, or not recorded. */
export type TurnSource = {
    name: string;
} | {
    self: true;
} | undefined;
/** What the chat says while a message waits for a turn the CLI started itself, in the language of that message. */
export declare const ownTurnWaitNote: (cli: string, userText: string) => string;
/** What the chat says at a `model_switch` item, in the language of what the user wrote. */
export declare function modelSwitchNote(item: TimelineEntry['item'], userText: string): string;
/**
 * The line a reply ends with while tools run: what the one started last works on, or its name if that says nothing, in the
 * language of what the user wrote. It is a link only so that the client can find it and draw it as one of DSH's tool rows; see
 * {@link TOOL_STATUS_URL}.
 */
export declare function toolStatus(running: readonly TimelineEntry['item'][], userText: string): string;
/**
 * One markdown block of a remote CLI session's saved history: what the user asked, what the CLI answered, and which
 * tools it used. Latest turns win when the history is long; the full record stays in the sessions panel.
 * With `elsewhere` the entries are turns sent outside this conversation, headed by where they came from.
 * `writing` is what the CLI is still writing at the end, left out for whoever follows the turn: it still names the CLI and sets the language.
 * `language` is what the user wrote in the conversation, which sets the language when these turns hold nothing they wrote.
 */
export declare function transcript(entries: readonly TimelineEntry[], options: {
    cli: string;
    creator?: string;
    elsewhere?: {
        from: TurnSource;
    };
    writing?: string;
    language?: string;
}): {
    text: string;
    lastMessageId?: string;
};
