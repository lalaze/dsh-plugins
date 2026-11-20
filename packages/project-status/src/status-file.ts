import { PARTS, type Goal, type Part } from './domain.js';
import { parseGoals, serializeGoals } from './goals.js';

/**
 * A status file is Markdown, in Chinese or English:
 *
 *     # shop
 *
 *     ## 大目标
 *     What the project as a whole is for.
 *
 *     ## 小目标
 *
 *     ### [ ] Payment page
 *     - [x] Design
 *     - [ ] Build
 *
 *     #### 进度
 *     …
 *     #### 卡点
 *     …
 *     #### 下一步
 *     …
 *
 * Each third-level heading is a goal with a status of its own. People and agents write the file by hand, so reading is
 * lenient: either language, any order, other sections anywhere. Writing puts the two sections first, under the headings
 * the file already used, and leaves everything else as it was.
 *
 * The first version had one status for the whole project: a task list under 目标 and second-level 进度/卡点/下一步. Such a
 * file reads as goals too (see {@link fromSingle}), and is written in the form above from the first save on.
 */
const AIM = ['大目标', '目标', '总目标', 'goal', 'goals', 'aim'];
const GOALS = ['小目标', '子目标', 'sub-goals', 'subgoals', 'sub goals', 'milestones'];
const PART: Record<Part, string[]> = {
  progress: ['进度', 'progress'],
  blockers: ['卡点', '问题', 'blockers', 'blocker', 'blocked', 'problems'],
  next: ['下一步', 'next', 'next step', 'next steps'],
};
const HEADINGS = {
  zh: { aim: '大目标', goals: '小目标', progress: '进度', blockers: '卡点', next: '下一步', general: '整体' },
  en: { aim: 'Goal', goals: 'Sub-goals', progress: 'Progress', blockers: 'Blockers', next: 'Next', general: 'General' },
};
const plain = (heading: string) => heading.replace(/[:：]\s*$/, '').trim().toLowerCase();
const partOf = (heading: string): Part | undefined => PARTS.find(part => PART[part].includes(plain(heading)));

/** A goal as the file has it: with whatever else was written under it. */
export interface ParsedGoal extends Goal {
  /** Fourth-level sections besides the three, heading lines included, as written. */
  rest: string[];
}
export interface ParsedStatus {
  /** What stands before the first section: usually a title line. */
  preamble: string;
  aim: string;
  goals: ParsedGoal[];
  /** The headings the two sections had in the file. */
  headings: { aim?: string; goals?: string };
  /** What stands in the goals' section before the first goal. */
  lead: string;
  /** Every other section, heading line included, as written. */
  extra: string[];
  /** The language the file's own headings are in, when it has any. */
  language?: 'zh' | 'en';
}

const trimBlank = (lines: string[]) => {
  let start = 0, end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join('\n');
};
/** A text as the file holds it: without the blank lines around it. */
export const tidy = (text: string): string => trimBlank(text.replace(/\r\n?/g, '\n').split('\n'));
/** A goal's name: one line, without the box an agent may have copied along. */
export const tidyTitle = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim();

interface Section { heading?: string; title: string; body: string }
/** Cuts a text at its headings of one level. A `#` line inside a code block is code. */
function sections(text: string, level: number): Section[] {
  const mark = '#'.repeat(level), result: Section[] = [];
  let heading: string | undefined, body: string[] = [], fence: string | undefined;
  const close = () => {
    const title = heading === undefined ? '' : heading.slice(level).replace(/\s+#+\s*$/, '').trim();
    result.push({ ...(heading === undefined ? {} : { heading }), title, body: trimBlank(body) });
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fenced = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenced) {
      if (!fence) fence = fenced[0];
      else if (fenced[0] === fence) fence = undefined;
    }
    if (!fence && !fenced && line.startsWith(`${mark} `) && line.slice(level).trim()) { close(); heading = line.trimEnd(); body = []; }
    else body.push(line);
  }
  close();
  return result;
}

function goalOf(section: Section): ParsedGoal {
  const box = /^\[([ xX])\]\s*(.*)$/.exec(section.title);
  const goal: ParsedGoal = { title: (box ? box[2] : section.title).trim(), done: !!box && box[1] !== ' ', steps: '', progress: '', blockers: '', next: '', rest: [] };
  const seen = new Set<Part>();
  for (const part of sections(section.body, 4)) {
    if (part.heading === undefined) { goal.steps = part.body; continue; }
    const name = partOf(part.title);
    // A second section under the same name is someone's note, not the text again.
    if (name && !seen.has(name)) { seen.add(name); goal[name] = part.body; }
    else goal.rest.push([part.heading, part.body].filter(Boolean).join('\n\n'));
  }
  return goal;
}

/**
 * The first version's file as goals: each task at the margin of its list becomes a goal with the tasks under it as its
 * steps, and the sentences beside the list stay the project's aim. The one status the project had goes to its only goal;
 * with several, nobody can tell which it was about, so it becomes a goal of its own.
 */
function fromSingle(aim: string, single: Record<Part, string>, language: 'zh' | 'en'): Pick<ParsedStatus, 'aim' | 'goals'> {
  const items = parseGoals(aim), goals: ParsedGoal[] = [], notes: string[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.depth > 0 || item.done === undefined) { notes.push(item.text); continue; }
    let end = index + 1;
    while (end < items.length && items[end].depth > 0) end++;
    goals.push({ title: item.text, done: item.done, steps: serializeGoals(items.slice(index + 1, end).map(step => ({ ...step, depth: step.depth - 1 }))), progress: '', blockers: '', next: '', rest: [] });
    index = end - 1;
  }
  if (PARTS.some(part => single[part])) {
    if (goals.length === 1) Object.assign(goals[0], single);
    else goals.unshift({ title: HEADINGS[language].general, done: false, steps: '', ...single, rest: [] });
  }
  return { aim: goals.length ? notes.join('\n') : aim, goals };
}

export function parseStatus(text: string): ParsedStatus {
  const result: ParsedStatus = { preamble: '', aim: '', goals: [], headings: {}, lead: '', extra: [] };
  const single: Record<Part, string> = { progress: '', blockers: '', next: '' }, found = new Set<Part>();
  let listed = false, chinese = 0, english = 0;
  for (const section of sections(text, 2)) {
    if (section.heading === undefined) { result.preamble = section.body; continue; }
    const name = plain(section.title), part = partOf(section.title);
    const known = () => { if (/[一-鿿]/.test(section.title)) chinese++; else english++; };
    if (AIM.includes(name) && result.headings.aim === undefined) { result.headings.aim = section.title; result.aim = section.body; known(); }
    else if (GOALS.includes(name) && !listed) {
      listed = true; result.headings.goals = section.title; known();
      for (const goal of sections(section.body, 3)) {
        if (goal.heading === undefined) result.lead = goal.body;
        else result.goals.push(goalOf(goal));
      }
    } else if (part && !found.has(part)) { found.add(part); single[part] = section.body; known(); }
    else result.extra.push([section.heading, section.body].filter(Boolean).join('\n\n'));
  }
  if (chinese + english) result.language = chinese >= english ? 'zh' : 'en';
  if (!listed) {
    const was = result.aim;
    Object.assign(result, fromSingle(was, single, result.language ?? 'zh'));
    // 目标 was the list; what is left of it is the project's aim, under the name the new form gives it.
    if (result.aim !== was) delete result.headings.aim;
  } else {
    // A file in the new form that still has one of the old sections: it is a note there.
    for (const part of PARTS) if (found.has(part)) result.extra.unshift([`## ${HEADINGS[result.language ?? 'zh'][part]}`, single[part]].filter(Boolean).join('\n\n'));
  }
  return result;
}

/**
 * @param language - of the headings, for a file that has none yet.
 * @param title - the title of a file that had nothing before its first section.
 */
export function serializeStatus(status: ParsedStatus, language: 'zh' | 'en', title: string): string {
  const names = HEADINGS[status.language ?? language], parts = [status.preamble || `# ${title}`];
  parts.push([`## ${status.headings.aim ?? names.aim}`, tidy(status.aim)].filter(Boolean).join('\n\n'));
  parts.push([`## ${status.headings.goals ?? names.goals}`, status.lead].filter(Boolean).join('\n\n'));
  for (const goal of status.goals) {
    parts.push([`### [${goal.done ? 'x' : ' '}] ${tidyTitle(goal.title)}`, tidy(goal.steps)].filter(Boolean).join('\n\n'));
    // An empty text needs no heading; the file stays as short as what there is to say.
    for (const part of PARTS) if (tidy(goal[part])) parts.push(`#### ${names[part]}\n\n${tidy(goal[part])}`);
    parts.push(...goal.rest);
  }
  parts.push(...status.extra);
  return `${parts.join('\n\n')}\n`;
}

/** What the tab and other plugins are told of a goal. */
export const shown = ({ rest: _rest, ...goal }: ParsedGoal): Goal => goal;
