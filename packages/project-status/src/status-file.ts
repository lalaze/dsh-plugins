import { FIELDS, type Field, type Fields } from './domain.js';

/**
 * A status file is Markdown with four second-level sections, in Chinese or English. People and agents write it by hand,
 * so reading is lenient: any order, either language, other sections anywhere. Writing puts the four first, under the
 * headings the file already used, and leaves everything else as it was.
 */
const ALIASES: Record<Field, string[]> = {
  goal: ['目标', 'goal', 'goals'],
  progress: ['进度', 'progress'],
  blockers: ['卡点', 'blockers', 'blocker', 'blocked'],
  next: ['下一步', 'next', 'next step', 'next steps'],
};
const HEADINGS: Record<'zh' | 'en', Record<Field, string>> = {
  zh: { goal: '目标', progress: '进度', blockers: '卡点', next: '下一步' },
  en: { goal: 'Goal', progress: 'Progress', blockers: 'Blockers', next: 'Next' },
};
const fieldOf = (heading: string): Field | undefined => {
  const plain = heading.replace(/[:：]\s*$/, '').trim().toLowerCase();
  return FIELDS.find(field => ALIASES[field].includes(plain));
};

export interface ParsedStatus {
  /** What stands before the first section: usually a title line. */
  preamble: string;
  fields: Fields;
  /** The heading each of the four had in the file. */
  headings: Partial<Record<Field, string>>;
  /** Every other section, heading line included, as written. */
  extra: string[];
}

const trimBlank = (lines: string[]) => {
  let start = 0, end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join('\n');
};

export function parseStatus(text: string): ParsedStatus {
  const result: ParsedStatus = { preamble: '', fields: { goal: '', progress: '', blockers: '', next: '' }, headings: {}, extra: [] };
  let heading: string | undefined, body: string[] = [], fence: string | undefined;
  const close = () => {
    if (heading === undefined) { result.preamble = trimBlank(body); return; }
    const title = heading.replace(/^##\s+/, '').replace(/\s+#+\s*$/, '').trim(), field = fieldOf(title);
    // A second section under the same name is someone's note, not the field again.
    if (field && result.headings[field] === undefined) { result.headings[field] = title; result.fields[field] = trimBlank(body); }
    else result.extra.push([heading, trimBlank(body)].filter(Boolean).join('\n\n'));
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    // A `## ` inside a code block is code.
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark[0];
      else if (mark[0] === fence) fence = undefined;
    }
    if (!fence && !mark && /^##\s+\S/.test(line)) { close(); heading = line.trimEnd(); body = []; }
    else body.push(line);
  }
  close();
  return result;
}

/**
 * @param language - the language of the headings a field gets when the file had none for it.
 * @param title - the title of a file that had nothing before its first section.
 */
export function serializeStatus(status: ParsedStatus, language: 'zh' | 'en', title: string): string {
  const parts = [status.preamble || `# ${title}`];
  for (const field of FIELDS) {
    const body = status.fields[field].replace(/\r\n?/g, '\n').split('\n');
    parts.push([`## ${status.headings[field] ?? HEADINGS[language][field]}`, trimBlank(body)].filter(Boolean).join('\n\n'));
  }
  parts.push(...status.extra);
  return `${parts.join('\n\n')}\n`;
}
