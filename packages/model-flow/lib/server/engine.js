/** The loop itself. It owns the order of the steps, so no model can skip the review or wave its own work through. */
import { implementPrompt, parseVerdict, planPrompt, retryVerdictNote, reviewPrompt } from './prompts.js';
import { rowText } from './shared.js';
const hasCjk = (text) => /[㐀-鿿]/u.test(text);
export function flowText(goal) {
    const zh = hasCjk(goal);
    const roleName = (role) => zh ? { plan: '计划', implement: '实现', review: '审核' }[role] : { plan: 'Plan', implement: 'Implement', review: 'Review' }[role];
    const time = (ms) => {
        const seconds = Math.max(1, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
        if (zh)
            return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : '钟'}` : `${seconds} 秒`;
        return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${seconds}s`;
    };
    const colon = zh ? '：' : ': ';
    const paren = (inner) => zh ? `（${inner}）` : ` (${inner})`;
    const roundLabel = (round) => zh ? `第 ${round} 轮` : `Round ${round}`;
    const prefix = (role, round) => role === 'plan' ? '' : `${roundLabel(round)}${colon}`;
    return {
        roleName, time, roundLabel,
        started: (routes, rounds, attachments = 0) => {
            const steps = ['plan', 'implement', 'review'].flatMap(role => routes[role] ? [`${roleName(role)} ${routes[role].label}`] : []);
            return `${zh ? '已开始' : 'Started'}${colon}${steps.join(' → ')}${zh ? `，最多审核 ${rounds} 轮` : `, up to ${rounds} review round${rounds === 1 ? '' : 's'}`}${attachments > 0 ? zh ? `，${attachments} 个附件` : `, ${attachments} attachment${attachments === 1 ? '' : 's'}` : ''}`;
        },
        running: (role, round, route) => `${prefix(role, round)}${zh ? `${roleName(role)}中` : { plan: 'Planning', implement: 'Implementing', review: 'Reviewing' }[role]} · ${route.label}`,
        finished: (role, round, ms) => `${prefix(role, round)}${zh ? `${roleName(role)}完成` : `${roleName(role)} done`}${paren(time(ms))}`,
        halted: (role, round, ms) => `${prefix(role, round)}${zh ? `${roleName(role)}已停止` : `${roleName(role)} stopped`}${paren(time(ms))}`,
        reviewPassed: (round, ms) => `${roundLabel(round)}${colon}${zh ? '审核通过' : 'review passed'}${paren(time(ms))}`,
        sentBack: (round, ms) => `${roundLabel(round)}${colon}${zh ? '审核打回' : 'review sent it back'}${paren(time(ms))}`,
        askedAgain: (round, ms) => `${roundLabel(round)}${colon}${zh ? '审核没有给出结论，再问一次' : 'the review gave no verdict, so it is asked again'}${paren(time(ms))}`,
        passed: (round, ms) => `${zh ? '完成' : 'Done'}${colon}${zh ? `第 ${round} 轮审核通过，共 ${time(ms)}` : `review passed in round ${round}, ${time(ms)} in all`}`,
        gaveUp: (rounds) => zh ? `审核 ${rounds} 轮仍未通过，交给你决定` : `Review did not pass after ${rounds} round${rounds === 1 ? '' : 's'}, so this is yours to decide`,
        /** What the last implementer said it did and what the last reviewer found, the end of a flow's report in the chat. */
        outcome: (built, reviewed) => [built && `**${roleName('implement')}**\n\n${built}`, reviewed && `**${roleName('review')}**\n\n${reviewed}`].filter(Boolean).join('\n\n'),
        failed: (role, reason) => `${roleName(role)}${zh ? '失败' : ' failed'}${colon}${reason}`,
        noVerdict: zh ? '审核两次都没有给出结论，流程已停止。可以在子智能体列表里看它的回复。' : 'The review gave no verdict twice, so the flow stopped. Its reply is in the subagent list.',
        stopped: zh ? '已停止' : 'Stopped',
        reportSummary: zh ? '流程结果' : 'Flow result',
    };
}
export const brief = (text, limit = 400) => {
    const flat = text.replace(/\s+/gu, ' ').trim();
    return [...flat].length <= limit ? flat : `${[...flat].slice(0, limit).join('')}…`;
};
const REPORT_PART = 6000;
const reportPart = (label, text) => text?.trim() ? `\n\n${label}:\n${text.trim().slice(0, REPORT_PART)}` : '';
/** Written for a model, so always in English; the goal and the replies stay in their own language. */
function flowReport(goal, ending, built, reviewed) {
    return `A /flow run in this conversation just ended. Other models did the work, so none of it is in your history.\n\nGoal:\n${goal}\n\nHow it ended: ${ending}${reportPart('What the last implementer reported', built)}${reportPart('What the last reviewer reported', reviewed)}\n\nAny changes are in the working tree as those models left them. Use this as context if the user's next message is about that work.`;
}
export async function runFlow(input, host) {
    const { goal, routes, rounds, signal } = input, text = flowText(goal), now = host.now ?? Date.now, startedAt = now();
    /** What the latest steps ended with, for the report however the flow ends. */
    let built, reviewed;
    /** One step, shown as one row from start to result. A returned outcome means the flow is over and has been reported. */
    const step = async (role, round, prompt, readOnly, route, describe) => {
        // The /flow stop command's own row already says the flow stopped.
        if (signal.aborted)
            return { status: 'stopped' };
        const at = now(), row = host.openRow(text.running(role, round, route));
        const halted = async () => {
            await row.close({ kind: 'success', title: text.halted(role, round, now() - at) });
            host.report?.(flowReport(goal, `the user stopped it during the ${role} step.`, built, reviewed));
            return { status: 'stopped' };
        };
        const fail = async (reason) => {
            await row.close({ kind: 'error', title: text.failed(role, reason) });
            host.report?.(flowReport(goal, `the ${role} step failed: ${reason}`, built, reviewed));
            return { status: 'failed', reason };
        };
        let result;
        try {
            result = await host.run({ role, round, route, prompt, readOnly, signal, row });
        }
        catch (error) {
            return signal.aborted ? halted() : fail(error instanceof Error ? error.message : String(error));
        }
        // Stopped from the step's own view: the flow's signal knows nothing about that, and there is nothing to go on with.
        if (signal.aborted || result.stopReason === 'aborted')
            return halted();
        if (result.stopReason !== 'completed')
            return fail(result.diagnostic || result.text.trim() || result.stopReason);
        await row.close({ kind: 'success', ...(describe?.(result, now() - at) ?? { title: text.finished(role, round, now() - at), body: result.closing ?? result.text }) });
        return result;
    };
    const isOutcome = (value) => 'status' in value;
    let plan;
    if (routes.plan) {
        const result = await step('plan', 0, planPrompt(goal), true, routes.plan);
        if (isOutcome(result))
            return result;
        plan = result.text;
    }
    const describeReview = (round) => (result, ms) => {
        const { verdict } = parseVerdict(result.text);
        return { title: verdict === 'pass' ? text.reviewPassed(round, ms) : verdict ? text.sentBack(round, ms) : text.askedAgain(round, ms), body: parseVerdict(result.closing ?? result.text).body };
    };
    let findings, summary;
    for (let round = 1; round <= rounds; round++) {
        const implemented = await step('implement', round, implementPrompt({ goal, plan, round, findings, lastSummary: summary }), false, routes.implement);
        if (isOutcome(implemented))
            return implemented;
        summary = implemented.text;
        built = implemented.closing ?? implemented.text;
        const prompt = reviewPrompt({ goal, plan, round, summary, findings });
        let review = await step('review', round, prompt, true, routes.review, describeReview(round));
        if (isOutcome(review))
            return review;
        let parsed = parseVerdict(review.text);
        // A model forgetting one line should not cost a whole round of implementation.
        if (!parsed.verdict) {
            review = await step('review', round, prompt + retryVerdictNote, true, routes.review, describeReview(round));
            if (isOutcome(review))
                return review;
            parsed = parseVerdict(review.text);
            if (!parsed.verdict) {
                await host.note(text.noVerdict);
                host.report?.(flowReport(goal, 'the review gave no verdict twice, so the flow stopped without a result.', built));
                return { status: 'failed', reason: 'no verdict' };
            }
        }
        const closing = parseVerdict(review.closing ?? review.text).body;
        reviewed = closing;
        if (parsed.verdict === 'pass') {
            await host.note(rowText({ title: text.passed(round, now() - startedAt), body: text.outcome(built ?? '', closing), open: true }));
            host.report?.(flowReport(goal, `the review passed in round ${round}.`, built, closing));
            return { status: 'passed', round };
        }
        findings = parsed.body;
        if (round === rounds) {
            await host.note(rowText({ title: text.gaveUp(rounds), body: text.outcome(built ?? '', closing), open: true }));
            host.report?.(flowReport(goal, `the review still rejected the work after ${rounds} round${rounds === 1 ? '' : 's'}, so the decision is the user's.`, built, closing));
            return { status: 'rejected', rounds, findings };
        }
    }
    return { status: 'failed', reason: 'no rounds' };
}
