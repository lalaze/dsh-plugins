/** What a person types after /fix: optionally where the bug goes, then the bug in their own words. */
export interface FixLine { repo?: string; branch?: string; title: string; body: string }
const OPTION = /^(repo|branch|仓库|分支)\s*[=＝:：]\s*(?:"([^"]*)"|“([^”]*)”|(\S+))\s*/iu;
const MAX_TITLE = 120;

/** `repo=` and `branch=` may lead the line, in either order; a name with spaces goes in quotes. The first line becomes the title. */
export function parseFix(raw: string): FixLine {
  let rest = raw.trim();
  const line: FixLine = { title: '', body: '' };
  for (let match = OPTION.exec(rest); match; match = OPTION.exec(rest)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim(), name = match[1].toLowerCase();
    if (name === 'repo' || name === '仓库') line.repo = value; else line.branch = value;
    rest = rest.slice(match[0].length);
  }
  const first = rest.split(/\r?\n/u).map(part => part.trim()).find(Boolean) ?? '', letters = [...first];
  line.title = letters.length > MAX_TITLE ? `${letters.slice(0, MAX_TITLE).join('').trim()}…` : first;
  // A title that says it all needs no description; anything more is kept whole, the first line included.
  line.body = rest.trim() === first && letters.length <= MAX_TITLE ? '' : rest.trim();
  return line;
}
