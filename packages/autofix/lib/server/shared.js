/** What the server and the pages both need to read a row in a conversation. Nothing here may come from Node. */
export const API_PATH = '/api/autofix';
export const COMMAND = 'fix';
/** Lines the plugin runs itself start with this invisible character, so nobody types one by accident. */
export const MARK = '\u2063';
const META = /\n*<!-- autofix-row (\{.*\}) -->\s*$/u;
/** The words are for DSH without this plugin; the page draws the row from the rest. */
export function rowText(words, meta) {
    // The meta must stay on one line: JSON escapes newlines but not these two, which end a line for the pattern above.
    const json = JSON.stringify(meta).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
    return `${words.trim()}\n\n<!-- autofix-row ${json} -->`;
}
export function parseRow(text) {
    const match = META.exec(text);
    if (!match)
        return { words: text.trim() };
    try {
        return { words: text.slice(0, match.index).trim(), meta: JSON.parse(match[1]) };
    }
    catch {
        return { words: text.trim() };
    }
}
