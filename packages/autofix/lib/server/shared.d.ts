/** What the server and the pages both need to read a row in a conversation. Nothing here may come from Node. */
export declare const API_PATH = "/api/autofix";
export declare const COMMAND = "fix";
/** Lines the plugin runs itself start with this invisible character, so nobody types one by accident. */
export declare const MARK = "\u2063";
/** A message that a page can say in its own language. */
export interface Said {
    key: string;
    values?: Record<string, string>;
    detail?: string;
}
/**
 * What a row is about, kept in its text because that is all DSH saves of a command's result: the task it shows, which of
 * the task's cards it is (`home` ones live in the task's own conversation and are numbered), or a sentence to say.
 * `at` is set when another DSH runs the task: the workspace of this DSH through whose machine it is followed.
 */
export interface RowMeta {
    key?: string;
    card?: number;
    home?: boolean;
    said?: Said;
    at?: string;
}
/** The words are for DSH without this plugin; the page draws the row from the rest. */
export declare function rowText(words: string, meta: RowMeta): string;
export declare function parseRow(text: string): {
    words: string;
    meta?: RowMeta;
};
