/** What the server and the pages both need to read a row in a conversation. Nothing here may come from Node. */
export const API_PATH = '/api/autofix';
export const COMMAND = 'fix';
/** Lines the plugin runs itself start with this invisible character, so nobody types one by accident. */
export const MARK = '\u2063';
/** A message that a page can say in its own language. */
export interface Said { key: string; values?: Record<string, string>; detail?: string }
/**
 * What a row is about, kept in its text because that is all DSH saves of a command's result: the task it shows, which of
 * the task's cards it is (`home` ones live in the task's own conversation and are numbered), or a sentence to say.
 * `at` is set when another DSH runs the task: the workspace of this DSH through whose machine it is followed.
 */
export interface RowMeta { key?: string; card?: number; home?: boolean; said?: Said; at?: string }
const META = /\n*<!-- autofix-row (\{.*\}) -->\s*$/u;
/** The words are for DSH without this plugin; the page draws the row from the rest. */
export function rowText(words: string, meta: RowMeta): string {
  // The meta must stay on one line: JSON escapes newlines but not these two, which end a line for the pattern above.
  const json = JSON.stringify(meta).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
  return `${words.trim()}\n\n<!-- autofix-row ${json} -->`;
}
export function parseRow(text: string): { words: string; meta?: RowMeta } {
  const match = META.exec(text);
  if (!match) return { words: text.trim() };
  try { return { words: text.slice(0, match.index).trim(), meta: JSON.parse(match[1]) as RowMeta }; }
  catch { return { words: text.trim() }; }
}
