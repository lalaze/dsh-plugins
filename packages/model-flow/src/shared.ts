/** Used on both sides, so it must not import anything from Node. */
import type { Role } from './routes.js';

export const API_PATH = '/api/model-flow';
export interface EffortOption { id: string; label: string }
export type Locale = 'en' | 'zh';
/** Commands the flow runs itself start with this invisible character, so the client knows them from typed ones. */
export const MARK = '⁣';

/** How a step ended. A review ends as passed, sent back, or without a verdict (asked again). */
export type StepStatus = 'running' | 'done' | 'passed' | 'sentBack' | 'noVerdict' | 'failed' | 'stopped';
/** `note` is the first line of a sent-back, failed or verdict-less step's result, shown under it without opening it. */
export interface CardStep { role: Role; round: number; model: string; machine?: string; status: StepStatus; ms?: number; childId?: string; body?: string; note?: string }
export type CardEnd =
  | { kind: 'passed'; round: number; sentBack: number; ms: number }
  | { kind: 'rejected'; rounds: number; ms: number }
  | { kind: 'failed'; role: Role; reason: string; ms: number }
  | { kind: 'stopped'; ms: number }
  | { kind: 'noVerdict'; ms: number };
/**
 * One flow, drawn as one card. `zh` is the goal's language, which the card speaks whatever the UI language is. `tag` is
 * what the plugin that started the flow named it (`<plugin>:<its own words>`), so its page can add to the card.
 */
export interface CardState { parentId: string; zh: boolean; rounds: number; planned?: boolean; steps: CardStep[]; end?: CardEnd; tag?: string }
/** A running card as the client polls it: no step results (fetched on demand), plus what changes every second. */
export interface LiveCard extends CardState { elapsed: number; activity?: string; interrupted?: boolean }

/** Rows are saved as text: a title, then the full result, then what the row needs to know that is not for reading. */
export interface RowParts { title: string; body?: string; parentId?: string; childId?: string; open?: boolean; start?: boolean; card?: CardState }
const META = /\n*<!-- flow-row (\{.*\}) -->\s*$/u;
const MAX_BODY = 40000;
/** A step's result inside a card; the whole conversation is one click away. */
export const MAX_STEP_BODY = 16000;
export const cut = (text: string | undefined, limit: number) => {
  const trimmed = text?.trim();
  return trimmed && trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed || undefined;
};
export function rowText({ title, body, parentId, childId, open, start, card }: RowParts): string {
  const kept = cut(body, MAX_BODY);
  const meta = { ...(parentId && childId ? { parentId, childId } : {}), ...(open ? { open } : {}), ...(start ? { start } : {}), ...(card ? { card } : {}) };
  // The meta must stay on one line: JSON escapes newlines but not these two, which end a line for the pattern above.
  const json = JSON.stringify(meta).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
  return `${title}${kept ? `\n\n${kept}` : ''}${Object.keys(meta).length ? `\n\n<!-- flow-row ${json} -->` : ''}`;
}
export function parseRow(text: string): RowParts {
  const match = META.exec(text), rest = match ? text.slice(0, match.index) : text, end = rest.indexOf('\n');
  const body = end < 0 ? '' : rest.slice(end + 1).trim();
  let meta: Pick<RowParts, 'parentId' | 'childId' | 'open' | 'start' | 'card'> = {};
  try { if (match) meta = JSON.parse(match[1]) as typeof meta; } catch { /* Text a model wrote can look like this; it is then just text. */ }
  if (meta.card && !Array.isArray(meta.card.steps)) delete meta.card;
  return { title: (end < 0 ? rest : rest.slice(0, end)).trim(), ...(body ? { body } : {}), ...meta };
}

/** The words a card is drawn with, in the goal's language. */
export function cardWords(zh: boolean) {
  const roleName = (role: Role) => zh ? { plan: '计划', implement: '实现', review: '审核' }[role] : { plan: 'Plan', implement: 'Implement', review: 'Review' }[role];
  const time = (ms: number) => formatTime(ms, zh);
  const step = (role: Role, round: number) => role === 'plan' ? roleName(role) : zh ? `第 ${round} 轮${roleName(role)}` : `${roleName(role)} · round ${round}`;
  const sentBack = (count: number) => zh ? `打回 ${count} 次` : `sent back ${count === 1 ? 'once' : `${count} times`}`;
  const rounds = (count: number) => zh ? `最多审核 ${count} 轮` : `up to ${count} review round${count === 1 ? '' : 's'}`;
  return {
    roleName, time, step, rounds,
    round: (round: number) => zh ? `第 ${round} 轮` : `Round ${round}`,
    running: (role: Role, round: number) => role === 'plan' ? (zh ? '计划中' : 'Planning')
      : zh ? `第 ${round} 轮${roleName(role)}中` : `${role === 'implement' ? 'Implementing' : 'Reviewing'}, round ${round}`,
    /** The line under a running card's title: who is at it, how it went so far, how far it may go. */
    doing: (current: CardStep, sentBackSoFar: number, maxRounds: number) => [
      zh ? `${current.model} 正在${roleName(current.role)}` : `${current.model} is ${{ plan: 'planning', implement: 'implementing', review: 'reviewing' }[current.role]}`,
      sentBackSoFar ? sentBack(sentBackSoFar) : '', rounds(maxRounds),
    ].filter(Boolean).join(' · '),
    tag: (status: StepStatus) => ({
      running: '', done: '',
      passed: zh ? '通过' : 'Passed', sentBack: zh ? '打回' : 'Sent back', noVerdict: zh ? '无结论' : 'No verdict',
      failed: zh ? '失败' : 'Failed', stopped: zh ? '已停止' : 'Stopped',
    })[status],
    starting: zh ? '正在开始' : 'Starting',
    interrupted: zh ? 'DSH 关闭时中断了' : 'Stopped when DSH closed',
    interruptedDetail: zh ? '流程没有继续，下面是它完成的步骤' : 'The flow did not go on; these are the steps it got through',
    title(end: CardEnd): string {
      switch (end.kind) {
        case 'passed': return zh ? `第 ${end.round} 轮审核通过` : `Review passed in round ${end.round}`;
        case 'rejected': return zh ? `审核 ${end.rounds} 轮仍未通过` : `Not passed after ${end.rounds} round${end.rounds === 1 ? '' : 's'}`;
        case 'failed': return zh ? `${roleName(end.role)}失败` : `${roleName(end.role)} failed`;
        case 'stopped': return zh ? '已停止' : 'Stopped';
        case 'noVerdict': return zh ? '审核没有给出结论' : 'The review gave no verdict';
      }
    },
    /** The line under a finished card's title. `last` is the step it stopped at. */
    detail(end: CardEnd, last?: CardStep): string {
      const total = zh ? `共 ${time(end.ms)}` : `${time(end.ms)} in all`;
      switch (end.kind) {
        case 'passed': return end.sentBack ? `${sentBack(end.sentBack)} · ${total}` : total;
        case 'rejected': return `${zh ? '交给你决定' : 'yours to decide'} · ${total}`;
        case 'failed': return end.reason;
        case 'stopped': return last ? `${zh ? `停在${step(last.role, last.round)}` : `stopped at ${step(last.role, last.round)}`} · ${total}` : total;
        case 'noVerdict': return `${zh ? '问了两次都没有结论' : 'asked twice without one'} · ${total}`;
      }
    },
    showSteps: (count: number) => zh ? `查看 ${count} 个步骤` : `Show ${count} step${count === 1 ? '' : 's'}`,
    hideSteps: zh ? '收起步骤' : 'Hide steps',
  };
}
/** A running clock: 1:05, or 1:02:05 past an hour. */
export function clock(ms: number): string {
  // Rounded like the durations written out, so a finished card's clock and its total agree.
  const total = Math.max(0, Math.round(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
export function formatTime(ms: number, zh: boolean): string {
  const seconds = Math.max(1, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (zh) return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : '钟'}` : `${seconds} 秒`;
  return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${seconds}s`;
}
