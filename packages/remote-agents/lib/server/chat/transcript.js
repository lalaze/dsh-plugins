/** Main-chat prompts carry earlier DSH messages ahead of the request; the transcript shows only what the user typed. */
const CONTEXT = /^Conversation context \(already occurred; do not repeat completed actions\):\n[\s\S]*?\n\nCurrent user request:\n/;
const USER_LIMIT = 4000, REPLY_LIMIT = 8000, TOTAL_LIMIT = 60_000;
const LABELS = {
    en: {
        title: (cli, creator, turns) => `**History of this ${cli} session**${creator ? ` (started on ${creator})` : ''}, ${turns} ${turns === 1 ? 'turn' : 'turns'}. Messages sent here continue the same session.`,
        elsewhere: (cli, from, turns) => `**${turns} ${turns === 1 ? 'turn' : 'turns'} ${from && 'name' in from ? `on ${from.name}` : from ? 'in Open sessions' : 'sent elsewhere'}**, in the same ${cli} session.`,
        omitted: (turns) => `_${turns} earlier ${turns === 1 ? 'turn is' : 'turns are'} not shown. The full record is in Settings → Remote agents → Open sessions._`,
        you: 'You', tools: 'Tools', interrupted: 'Interrupted', attachments: (n) => `${n} ${n === 1 ? 'attachment' : 'attachments'}`,
    },
    zh: {
        title: (cli, creator, turns) => `**这段 ${cli} 会话的历史记录**${creator ? `（在 ${creator} 上开始）` : ''}，共 ${turns} 轮。在这里发消息会接着同一个会话继续。`,
        elsewhere: (cli, from, turns) => `**${from && 'name' in from ? `在 ${from.name} 上` : from ? '在「打开会话」里' : '在别处'}进行的 ${turns} 轮**，同一个 ${cli} 会话。`,
        omitted: (turns) => `_前面还有 ${turns} 轮没有显示，完整记录在「设置 → 远程智能体 → 打开会话」里。_`,
        you: '你', tools: '工具', interrupted: '已中断', attachments: (n) => `${n} 个附件`,
    },
};
/** A cut keeps code fences balanced, so the rest of the transcript does not render as code. */
const fences = (text) => (text.match(/^\s*```/gm) ?? []).length;
function head(text, limit) {
    if (text.length <= limit)
        return text;
    const kept = text.slice(0, limit);
    return `${kept}${fences(kept) % 2 ? '\n```' : ''}\n…`;
}
function tail(text, limit) {
    if (text.length <= limit)
        return text;
    const kept = text.slice(-limit);
    return `…\n${fences(kept) % 2 ? '```\n' : ''}${kept}`;
}
const closed = (text) => fences(text) % 2 ? `${text}\n\`\`\`` : text;
function stamp(value) {
    const date = value ? new Date(value) : undefined;
    if (!date || Number.isNaN(date.getTime()))
        return '';
    const two = (n) => String(n).padStart(2, '0');
    return ` · ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
/**
 * One markdown block of a remote CLI session's saved history: what the user asked, what the CLI answered, and which
 * tools it used. Latest turns win when the history is long; the full record stays in the sessions panel.
 * With `elsewhere` the entries are turns sent outside this conversation, headed by where they came from.
 */
export function transcript(entries, options) {
    const turns = [];
    let turn, replying = false, lastMessageId;
    const current = () => turn ??= (turns.push({ attachments: 0, replies: [], tools: new Map(), errors: [], interrupted: false }), turns.at(-1));
    const seenTools = new Set();
    for (const entry of entries) {
        const item = entry.item;
        if (item.type === 'user_message') {
            turn = undefined;
            replying = false;
            const next = current();
            next.user = String(item.text ?? '').replace(CONTEXT, '').trim();
            next.at = entry.timestamp;
            next.attachments = Array.isArray(item.attachments) ? item.attachments.length : 0;
            if (typeof item.clientMessageId === 'string')
                lastMessageId = item.clientMessageId;
            continue;
        }
        const target = current();
        if (item.type === 'assistant_message') {
            const text = String(item.text ?? '');
            if (!text)
                continue;
            if (replying)
                target.replies[target.replies.length - 1] += text;
            else
                target.replies.push(text);
            replying = true;
            continue;
        }
        if (item.type === 'reasoning' || item.type === 'delivery')
            continue;
        replying = false;
        if (item.type === 'tool_call') {
            const key = String(item.callId ?? entry.seqStart);
            if (seenTools.has(key))
                continue;
            seenTools.add(key);
            const name = typeof item.name === 'string' && item.name ? item.name : 'Tool';
            target.tools.set(name, (target.tools.get(name) ?? 0) + 1);
        }
        else if (item.type === 'error')
            target.errors.push(String(item.message ?? ''));
        else if (item.type === 'interrupted' || item.type === 'turn_end' && item.status === 'canceled')
            target.interrupted = true;
    }
    const labels = /[㐀-鿿]/.test(turns.map(t => t.user ?? '').join('')) ? LABELS.zh : LABELS.en;
    const blocks = turns.map(t => {
        const parts = [];
        if (t.user !== undefined) {
            const extra = t.attachments ? ` (${labels.attachments(t.attachments)})` : '';
            parts.push(`**${labels.you}**${stamp(t.at)}${extra}\n\n${closed(head(t.user || '…', USER_LIMIT))}`);
        }
        const reply = t.replies.map(r => r.trim()).filter(Boolean).join('\n\n');
        const notes = [
            ...(t.tools.size ? [`${labels.tools}: ${[...t.tools].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(' · ')}`] : []),
            ...t.errors.filter(Boolean).map(error => head(error.replace(/\s+/g, ' '), 300)),
            ...(t.interrupted ? [labels.interrupted] : []),
        ];
        if (reply || notes.length)
            parts.push(`**${options.cli}**${reply ? `\n\n${closed(tail(reply, REPLY_LIMIT))}` : ''}${notes.length ? `\n\n_${notes.join(' · ').replace(/_/g, '\\_')}_` : ''}`);
        return parts.join('\n\n');
    });
    // Newest first until the budget is spent; the latest turn is always shown.
    const shown = [];
    let size = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (shown.length && size + blocks[i].length > TOTAL_LIMIT)
            break;
        shown.unshift(blocks[i]);
        size += blocks[i].length;
    }
    const omitted = blocks.length - shown.length;
    const title = options.elsewhere ? labels.elsewhere(options.cli, options.elsewhere.from, turns.length) : labels.title(options.cli, options.creator, turns.length);
    const text = [title, ...(omitted ? [labels.omitted(omitted)] : []), ...shown].join('\n\n---\n\n');
    return { text, ...(lastMessageId ? { lastMessageId } : {}) };
}
