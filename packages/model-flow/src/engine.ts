/** The loop itself. It owns the order of the steps, so no model can skip the review or wave its own work through. */
import { implementPrompt, parseVerdict, planPrompt, retryVerdictNote, reviewPrompt } from './prompts.js';
import type { Role, Route, Routes } from './routes.js';
import { formatTime, type CardEnd, type StepStatus } from './shared.js';

/** One step in the flow's card, shown running until it is closed with how it ended. */
export interface StepRow {
  /** Which conversation is doing the step, so the card can show its progress and open it. */
  attach(childId: string): void;
  close(result: { status: Exclude<StepStatus, 'running'>; body?: string }): Promise<void>;
}
export interface ChildRequest { role: Role; round: number; route: Route; prompt: string; readOnly: boolean; signal: AbortSignal; row: StepRow }
/** `text` is the whole reply; `closing` is its last message, without the progress sentences before it. */
export interface ChildResult { text: string; closing?: string; stopReason: string; diagnostic?: string }
/** How the flow ended, with the report for the chat when there is work to report. */
export type FlowEnd = CardEnd & { report?: string };
export interface FlowHost {
  run(request: ChildRequest): Promise<ChildResult>;
  openRow(step: { role: Role; round: number; route: Route }): StepRow;
  /** Called once, whichever way the flow ends. */
  finish?(end: FlowEnd): Promise<void>;
  /** What happened, for the conversation's own model: it took no part, and the next message may well be about it. */
  report?(text: string): void;
  now?(): number;
}
export interface FlowInput { goal: string; routes: Routes; rounds: number; signal: AbortSignal }
export type FlowOutcome =
  | { status: 'passed'; round: number }
  | { status: 'rejected'; rounds: number; findings: string }
  | { status: 'failed'; reason: string }
  | { status: 'stopped' };

export const hasCjk = (text: string) => /[㐀-鿿]/u.test(text);
export function flowText(goal: string) {
  const zh = hasCjk(goal);
  const roleName = (role: Role) => zh ? { plan: '计划', implement: '实现', review: '审核' }[role] : { plan: 'Plan', implement: 'Implement', review: 'Review' }[role];
  const time = (ms: number) => formatTime(ms, zh);
  const colon = zh ? '：' : ': ';
  return {
    roleName, time,
    started: (routes: Routes, rounds: number, attachments = 0) => {
      const steps = (['plan', 'implement', 'review'] as const).flatMap(role => routes[role] ? [`${roleName(role)} ${routes[role]!.label}`] : []);
      return `${zh ? '已开始' : 'Started'}${colon}${steps.join(' → ')}${zh ? `，最多审核 ${rounds} 轮` : `, up to ${rounds} review round${rounds === 1 ? '' : 's'}`}${attachments > 0 ? zh ? `，${attachments} 个附件` : `, ${attachments} attachment${attachments === 1 ? '' : 's'}` : ''}`;
    },
    passed: (round: number, ms: number) => `${zh ? '完成' : 'Done'}${colon}${zh ? `第 ${round} 轮审核通过，共 ${time(ms)}` : `review passed in round ${round}, ${time(ms)} in all`}`,
    gaveUp: (rounds: number) => zh ? `审核 ${rounds} 轮仍未通过，交给你决定` : `Review did not pass after ${rounds} round${rounds === 1 ? '' : 's'}, so this is yours to decide`,
    /** What the last implementer said it did and what the last reviewer found, the end of a flow's report in the chat. */
    outcome: (built: string, reviewed: string) => [built && `**${roleName('implement')}**\n\n${built}`, reviewed && `**${roleName('review')}**\n\n${reviewed}`].filter(Boolean).join('\n\n'),
    failed: (role: Role, reason: string) => `${roleName(role)}${zh ? '失败' : ' failed'}${colon}${reason}`,
    noVerdict: zh ? '审核两次都没有给出结论，流程已停止。可以在子智能体列表里看它的回复。' : 'The review gave no verdict twice, so the flow stopped. Its reply is in the subagent list.',
    stopped: zh ? '已停止' : 'Stopped',
    /** The first line a flow's card is saved with, which is also what DSH shows without this plugin. */
    ended(end: CardEnd): string {
      switch (end.kind) {
        case 'passed': return this.passed(end.round, end.ms);
        case 'rejected': return this.gaveUp(end.rounds);
        case 'failed': return this.failed(end.role, end.reason);
        case 'stopped': return this.stopped;
        case 'noVerdict': return this.noVerdict;
      }
    },
    reportSummary: zh ? '流程结果' : 'Flow result',
  };
}
export const brief = (text: string, limit = 400) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return [...flat].length <= limit ? flat : `${[...flat].slice(0, limit).join('')}…`;
};

const REPORT_PART = 6000;
const reportPart = (label: string, text: string | undefined) => text?.trim() ? `\n\n${label}:\n${text.trim().slice(0, REPORT_PART)}` : '';
/** Written for a model, so always in English; the goal and the replies stay in their own language. */
function flowReport(goal: string, ending: string, built?: string, reviewed?: string): string {
  return `A /flow run in this conversation just ended. Other models did the work, so none of it is in your history.\n\nGoal:\n${goal}\n\nHow it ended: ${ending}${reportPart('What the last implementer reported', built)}${reportPart('What the last reviewer reported', reviewed)}\n\nAny changes are in the working tree as those models left them. Use this as context if the user's next message is about that work.`;
}

export async function runFlow(input: FlowInput, host: FlowHost): Promise<FlowOutcome> {
  const { goal, routes, rounds, signal } = input, text = flowText(goal), now = host.now ?? Date.now, startedAt = now();
  const elapsed = () => now() - startedAt;
  /** What the latest steps ended with, for the report however the flow ends. */
  let built: string | undefined, reviewed: string | undefined;
  const stopped = async (): Promise<FlowOutcome> => { await host.finish?.({ kind: 'stopped', ms: elapsed() }); return { status: 'stopped' }; };
  /** One step, shown in the card from start to result. A returned outcome means the flow is over and has been reported. */
  const step = async (role: Role, round: number, prompt: string, readOnly: boolean, route: Route, describe?: (result: ChildResult) => { status: 'passed' | 'sentBack' | 'noVerdict'; body: string }): Promise<ChildResult | FlowOutcome> => {
    if (signal.aborted) return stopped();
    const row = host.openRow({ role, round, route });
    const halted = async (): Promise<FlowOutcome> => {
      await row.close({ status: 'stopped' });
      host.report?.(flowReport(goal, `the user stopped it during the ${role} step.`, built, reviewed));
      return stopped();
    };
    const fail = async (reason: string): Promise<FlowOutcome> => {
      await row.close({ status: 'failed', body: reason });
      host.report?.(flowReport(goal, `the ${role} step failed: ${reason}`, built, reviewed));
      await host.finish?.({ kind: 'failed', role, reason, ms: elapsed() });
      return { status: 'failed', reason };
    };
    let result: ChildResult;
    try { result = await host.run({ role, round, route, prompt, readOnly, signal, row }); }
    catch (error) { return signal.aborted ? halted() : fail(error instanceof Error ? error.message : String(error)); }
    // Stopped from the step's own view: the flow's signal knows nothing about that, and there is nothing to go on with.
    if (signal.aborted || result.stopReason === 'aborted') return halted();
    if (result.stopReason !== 'completed') return fail(result.diagnostic || result.text.trim() || result.stopReason);
    await row.close(describe?.(result) ?? { status: 'done', body: result.closing ?? result.text });
    return result;
  };
  const isOutcome = (value: ChildResult | FlowOutcome): value is FlowOutcome => 'status' in value;

  let plan: string | undefined;
  if (routes.plan) {
    const result = await step('plan', 0, planPrompt(goal), true, routes.plan);
    if (isOutcome(result)) return result;
    plan = result.text;
  }
  const describeReview = (result: ChildResult) => {
    const { verdict } = parseVerdict(result.text);
    return { status: verdict === 'pass' ? 'passed' as const : verdict ? 'sentBack' as const : 'noVerdict' as const, body: parseVerdict(result.closing ?? result.text).body };
  };
  let findings: string | undefined, summary: string | undefined;
  for (let round = 1; round <= rounds; round++) {
    const implemented = await step('implement', round, implementPrompt({ goal, plan, round, findings, lastSummary: summary }), false, routes.implement);
    if (isOutcome(implemented)) return implemented;
    summary = implemented.text; built = implemented.closing ?? implemented.text;
    const prompt = reviewPrompt({ goal, plan, round, summary, findings });
    let review = await step('review', round, prompt, true, routes.review, describeReview);
    if (isOutcome(review)) return review;
    let parsed = parseVerdict(review.text);
    // A model forgetting one line should not cost a whole round of implementation.
    if (!parsed.verdict) {
      review = await step('review', round, prompt + retryVerdictNote, true, routes.review, describeReview);
      if (isOutcome(review)) return review;
      parsed = parseVerdict(review.text);
      if (!parsed.verdict) {
        host.report?.(flowReport(goal, 'the review gave no verdict twice, so the flow stopped without a result.', built));
        await host.finish?.({ kind: 'noVerdict', ms: elapsed() });
        return { status: 'failed', reason: 'no verdict' };
      }
    }
    const closing = parseVerdict(review.closing ?? review.text).body;
    reviewed = closing;
    if (parsed.verdict === 'pass') {
      host.report?.(flowReport(goal, `the review passed in round ${round}.`, built, closing));
      await host.finish?.({ kind: 'passed', round, sentBack: round - 1, ms: elapsed(), report: text.outcome(built ?? '', closing) });
      return { status: 'passed', round };
    }
    findings = parsed.body;
    if (round === rounds) {
      host.report?.(flowReport(goal, `the review still rejected the work after ${rounds} round${rounds === 1 ? '' : 's'}, so the decision is the user's.`, built, closing));
      await host.finish?.({ kind: 'rejected', rounds, ms: elapsed(), report: text.outcome(built ?? '', closing) });
      return { status: 'rejected', rounds, findings };
    }
  }
  return { status: 'failed', reason: 'no rounds' };
}
