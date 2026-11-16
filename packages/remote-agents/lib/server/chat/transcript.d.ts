import { type Permission, type TimelineEntry } from '../core/domain.js';
/** What the chat says while a message waits for a turn the CLI started itself, in the language of that message. */
export declare const ownTurnWaitNote: (cli: string, userText: string) => string;
/** What the chat says at a `model_switch` item, in the language of what the user wrote. */
export declare function modelSwitchNote(item: TimelineEntry['item'], userText: string): string;
/**
 * The line a reply shows where DSH refused a CLI's request without showing it, in the language of what the user wrote. Without it
 * the turn can end in silence: an ACP CLI such as Antigravity hears no reason and often stops without a word.
 */
export declare function refusalNote(cli: string, permission: Pick<Permission, 'name' | 'title' | 'input' | 'detail'>, userText: string): string;
/**
 * The line a reply ends with while tools run: what the one started last works on, or its name if that says nothing, in the
 * language of what the user wrote. It is a link only so that the client can find it and draw it as one of DSH's tool rows; see
 * {@link TOOL_STATUS_URL}.
 */
export declare function toolStatus(running: readonly TimelineEntry['item'][], userText: string): string;
/**
 * One markdown block of turns a remote CLI session ran without a message from its conversation: what was asked, what the
 * CLI answered, and which tools it used. Latest turns win when there are many; the full record stays in the sessions panel.
 * `writing` is what the CLI is still writing at the end, left out for whoever follows the turn: it still names the CLI and sets the language.
 * `language` is what the user wrote in the conversation, which sets the language when these turns hold nothing they wrote.
 */
export declare function transcript(entries: readonly TimelineEntry[], options: {
    cli: string;
    writing?: string;
    language?: string;
}): {
    text: string;
    lastMessageId?: string;
};
