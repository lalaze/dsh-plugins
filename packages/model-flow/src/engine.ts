/** The loop itself. It owns the order of the steps, so no model can skip the review or wave its own work through. */
import { implementPrompt, parseVerdict, planPrompt, retryVerdictNote, reviewPrompt } from './prompts.js';
import type { Role, Route, Routes } from './routes.js';

export interface ChildRequest { role: Role; round: number; route: Route; prompt: string; readOnly: boolean; signal: AbortSignal }
/** `text` is the whole reply; `closing` is its last message, without the progress sentences before it. */
export interface ChildResult { text: string; closing?: string; stopReason: string; diagnostic?: string }
export interface FlowHost {
  run(request: ChildRequest): Promise<ChildResult>;
  note(text: string): Promise<void>;
  now?(): number;
}
export interface FlowInput { goal: string; routes: Routes; rounds: number; signal: AbortSignal }
export type FlowOutcome =
  | { status: 'passed'; round: number }
  | { status: 'rejected'; rounds: number; findings: string }
  | { status: 'failed'; reason: string }
  | { status: 'stopped' };

const hasCjk = (text: string) => /[㐀-鿿]/u.test(text);
export function flowText(goal: string) {
  const zh = hasCjk(goal);
  const roleName = (role: Role) => zh ? { plan: '计划', implement: '实现', review: '审核' }[role] : { plan: 'Plan', implement: 'Implement', review: 'Review' }[role];
  const time = (ms: number) => {
    const seconds = Math.max(1, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
    if (zh) return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : '钟'}` : `${seconds} 秒`;
    return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${seconds}s`;
  };
  const colon = zh ? '：' : ': ', stop = zh ? '。' : '. ';
  const paren = (inner: string) => zh ? `（${inner}）` : ` (${inner})`;
  const roundLabel = (round: number) => zh ? `第 ${round} 轮` : `Round ${round}`;
  return {
    roleName, time, roundLabel,
    started: (routes: Routes, rounds: number) => {
      const steps = (['plan', 'implement', 'review'] as const).flatMap(role => routes[role] ? [`${roleName(role)} ${routes[role]!.label}`] : []);
      return `${zh ? '已开始' : 'Started'}${colon}${steps.join(' → ')}${zh ? `，最多审核 ${rounds} 轮` : `, up to ${rounds} review round${rounds === 1 ? '' : 's'}`}`;
    },
    finished: (role: Role, round: number, ms: number) => {
      const done = zh ? `${roleName(role)}完成` : `${roleName(role)} done`;
      return `${role === 'plan' ? '' : `${roundLabel(round)}${colon}`}${done}${paren(time(ms))}`;
    },
    sentBack: (round: number, findings: string) => `${roundLabel(round)}${colon}${zh ? '审核打回' : 'review sent it back'}${stop}${brief(findings)}`,
    passed: (round: number, ms: number, summary: string) => `${zh ? '完成' : 'Done'}${colon}${zh ? `第 ${round} 轮审核通过，共 ${time(ms)}` : `review passed in round ${round}, ${time(ms)} in all`}${stop}${brief(summary)}`,
    gaveUp: (rounds: number, findings: string) => `${zh ? `审核 ${rounds} 轮仍未通过，交给你决定。还剩的问题` : `Review did not pass after ${rounds} round${rounds === 1 ? '' : 's'}, so this is yours to decide. What is left`}${colon}${brief(findings)}`,
    failed: (role: Role, reason: string) => `${roleName(role)}${zh ? '失败' : ' failed'}${colon}${reason}`,
    noVerdict: zh ? '审核两次都没有给出结论，流程已停止。可以在子智能体列表里看它的回复。' : 'The review gave no verdict twice, so the flow stopped. Its reply is in the subagent list.',
    stopped: zh ? '已停止' : 'Stopped',
  };
}
export const brief = (text: string, limit = 400) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return [...flat].length <= limit ? flat : `${[...flat].slice(0, limit).join('')}…`;
};

export async function runFlow(input: FlowInput, host: FlowHost): Promise<FlowOutcome> {
  const { goal, routes, rounds, signal } = input, text = flowText(goal), now = host.now ?? Date.now, startedAt = now();
  // The /flow stop command's own row already says so.
  const stopped = async (): Promise<FlowOutcome> => ({ status: 'stopped' });
  const fail = async (role: Role, reason: string): Promise<FlowOutcome> => { await host.note(text.failed(role, reason)); return { status: 'failed', reason }; };
  /** One step. A returned outcome means the flow is over and has been reported. */
  const step = async (role: Role, round: number, prompt: string, readOnly: boolean, route: Route): Promise<ChildResult | FlowOutcome> => {
    if (signal.aborted) return stopped();
    const at = now();
    let result: ChildResult;
    try { result = await host.run({ role, round, route, prompt, readOnly, signal }); }
    catch (error) { return signal.aborted ? stopped() : fail(role, error instanceof Error ? error.message : String(error)); }
    if (signal.aborted) return stopped();
    if (result.stopReason !== 'completed') return fail(role, result.diagnostic || result.text.trim() || result.stopReason);
    if (role !== 'review') await host.note(text.finished(role, round, now() - at));
    return result;
  };
  const isOutcome = (value: ChildResult | FlowOutcome): value is FlowOutcome => 'status' in value;

  let plan: string | undefined;
  if (routes.plan) {
    const result = await step('plan', 0, planPrompt(goal), true, routes.plan);
    if (isOutcome(result)) return result;
    plan = result.text;
  }
  let findings: string | undefined, summary: string | undefined;
  for (let round = 1; round <= rounds; round++) {
    const built = await step('implement', round, implementPrompt({ goal, plan, round, findings, lastSummary: summary }), false, routes.implement);
    if (isOutcome(built)) return built;
    summary = built.text;
    const prompt = reviewPrompt({ goal, plan, round, summary, findings });
    let review = await step('review', round, prompt, true, routes.review);
    if (isOutcome(review)) return review;
    let parsed = parseVerdict(review.text);
    // A model forgetting one line should not cost a whole round of implementation.
    if (!parsed.verdict) {
      review = await step('review', round, prompt + retryVerdictNote, true, routes.review);
      if (isOutcome(review)) return review;
      parsed = parseVerdict(review.text);
      if (!parsed.verdict) { await host.note(text.noVerdict); return { status: 'failed', reason: 'no verdict' }; }
    }
    if (parsed.verdict === 'pass') {
      await host.note(text.passed(round, now() - startedAt, parseVerdict(review.closing ?? review.text).body));
      return { status: 'passed', round };
    }
    findings = parsed.body;
    const closing = parseVerdict(review.closing ?? review.text).body;
    if (round === rounds) { await host.note(text.gaveUp(rounds, closing)); return { status: 'rejected', rounds, findings }; }
    await host.note(text.sentBack(round, closing));
  }
  return { status: 'failed', reason: 'no rounds' };
}
