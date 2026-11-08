export const API_PATH = '/api/model-flow';
/** Commands the flow runs itself start with this invisible character, so the client knows them from typed ones. */
export const MARK = '⁣';
const META = /\n*<!-- flow-row (\{.*\}) -->\s*$/u;
const MAX_BODY = 40000;
/** A step's result inside a card; the whole conversation is one click away. */
export const MAX_STEP_BODY = 16000;
export const cut = (text, limit) => {
    const trimmed = text?.trim();
    return trimmed && trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed || undefined;
};
export function rowText({ title, body, parentId, childId, open, start, card }) {
    const kept = cut(body, MAX_BODY);
    const meta = { ...(parentId && childId ? { parentId, childId } : {}), ...(open ? { open } : {}), ...(start ? { start } : {}), ...(card ? { card } : {}) };
    // The meta must stay on one line: JSON escapes newlines but not these two, which end a line for the pattern above.
    const json = JSON.stringify(meta).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
    return `${title}${kept ? `\n\n${kept}` : ''}${Object.keys(meta).length ? `\n\n<!-- flow-row ${json} -->` : ''}`;
}
export function parseRow(text) {
    const match = META.exec(text), rest = match ? text.slice(0, match.index) : text, end = rest.indexOf('\n');
    const body = end < 0 ? '' : rest.slice(end + 1).trim();
    let meta = {};
    try {
        if (match)
            meta = JSON.parse(match[1]);
    }
    catch { /* Text a model wrote can look like this; it is then just text. */ }
    if (meta.card && !Array.isArray(meta.card.steps))
        delete meta.card;
    return { title: (end < 0 ? rest : rest.slice(0, end)).trim(), ...(body ? { body } : {}), ...meta };
}
/** The words a card is drawn with, in the goal's language. */
export function cardWords(zh) {
    const roleName = (role) => zh ? { plan: '计划', implement: '实现', review: '审核' }[role] : { plan: 'Plan', implement: 'Implement', review: 'Review' }[role];
    const time = (ms) => formatTime(ms, zh);
    return {
        roleName, time,
        step: (role, round) => role === 'plan' ? roleName(role) : zh ? `第 ${round} 轮${roleName(role)}` : `${roleName(role)} · round ${round}`,
        running: (role, round) => role === 'plan' ? (zh ? '计划中' : 'Planning')
            : zh ? `第 ${round} 轮${roleName(role)}中` : `${role === 'implement' ? 'Implementing' : 'Reviewing'}, round ${round}`,
        tag: (status) => ({
            running: '', done: '',
            passed: zh ? '通过' : 'Passed', sentBack: zh ? '打回' : 'Sent back', noVerdict: zh ? '无结论' : 'No verdict',
            failed: zh ? '失败' : 'Failed', stopped: zh ? '已停止' : 'Stopped',
        })[status],
        starting: zh ? '正在开始' : 'Starting',
        interrupted: zh ? 'DSH 关闭时中断了' : 'Stopped when DSH closed',
        summary(end) {
            const at = ` · ${time(end.ms)}`;
            switch (end.kind) {
                case 'passed': return (zh ? `第 ${end.round} 轮审核通过` : `Review passed in round ${end.round}`)
                    + (end.sentBack ? zh ? ` · 打回 ${end.sentBack} 次` : ` · sent back ${end.sentBack === 1 ? 'once' : `${end.sentBack} times`}` : '') + at;
                case 'rejected': return (zh ? `审核 ${end.rounds} 轮仍未通过，交给你决定` : `Review did not pass after ${end.rounds} round${end.rounds === 1 ? '' : 's'}, yours to decide`) + at;
                case 'failed': return zh ? `${roleName(end.role)}失败：${end.reason}` : `${roleName(end.role)} failed: ${end.reason}`;
                case 'stopped': return (zh ? '已停止' : 'Stopped') + at;
                case 'noVerdict': return zh ? '审核两次都没有给出结论，流程已停止' : 'The review gave no verdict twice, so the flow stopped';
            }
        },
        rounds: (rounds) => zh ? `最多审核 ${rounds} 轮` : `Up to ${rounds} review round${rounds === 1 ? '' : 's'}`,
    };
}
export function formatTime(ms, zh) {
    const seconds = Math.max(1, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
    if (zh)
        return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : '钟'}` : `${seconds} 秒`;
    return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${seconds}s`;
}
