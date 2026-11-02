const asDict = (value) => (typeof value === 'object' && value !== null ? value : {});
/** Longest single message kept whole; longer ones keep their beginning and end. */
const ENTRY_CHARS = 6_000;
export const MAX_NOTE = 20_000;
const DEFAULT_NOTE = 'Review where that conversation left off and briefly tell me the state of the work. Wait for my instructions before making changes.';
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map(raw => {
        const block = asDict(raw);
        if (block.type === 'text')
            return String(block.text ?? '');
        if (block.type === 'image')
            return '[image]';
        if (block.type === 'file')
            return `[file: ${String(asDict(block.attachment).name ?? 'attachment')}]`;
        return '';
    }).filter(Boolean).join('\n');
}
function clip(text) {
    if (text.length <= ENTRY_CHARS)
        return text;
    const head = Math.floor(ENTRY_CHARS * 2 / 3), tail = ENTRY_CHARS - head;
    return `${text.slice(0, head)}\n… [${text.length - head - tail} characters left out] …\n${text.slice(-tail)}`;
}
/** User and assistant turns in order; consecutive assistant messages form one entry. */
export function conversationEntries(events) {
    const announced = new Set();
    for (const event of events) {
        if (event.type !== 'assistant/message')
            continue;
        for (const block of asDict(asDict(event.data).message).content ?? [])
            if (asDict(block).type === 'tool-call')
                announced.add(String(asDict(block).id));
    }
    const entries = [];
    const assistant = () => {
        const last = entries.at(-1);
        if (last?.role === 'assistant')
            return last;
        const entry = { role: 'assistant', text: '', tools: [] };
        entries.push(entry);
        return entry;
    };
    for (const event of events) {
        const data = asDict(event.data);
        if (event.type === 'user/message') {
            const text = contentText(data.content ?? asDict(data.message).content).trim();
            if (text)
                entries.push({ role: 'user', text, tools: [] });
        }
        else if (event.type === 'assistant/message') {
            const content = asDict(data.message).content;
            const blocks = Array.isArray(content) ? content.map(asDict) : [];
            const text = contentText(blocks.filter(block => block.type === 'text')).trim();
            const tools = blocks.filter(block => block.type === 'tool-call').map(block => String(block.name ?? 'tool'));
            if (!text && !tools.length)
                continue;
            const entry = assistant();
            if (text)
                entry.text = entry.text ? `${entry.text}\n\n${text}` : text;
            entry.tools.push(...tools);
        }
        else if (event.type === 'tool/call' && !announced.has(String(data.callId)))
            assistant().tools.push(String(data.name ?? 'tool'));
    }
    return entries;
}
function render(entry) {
    const counts = new Map();
    for (const tool of entry.tools)
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const tools = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
    return [`[${entry.role === 'user' ? 'User' : 'Assistant'}]`, entry.text && clip(entry.text), tools && `(Tools used: ${tools})`].filter(Boolean).join('\n');
}
/**
 * The whole first message, at most `limit` characters: a short introduction, the most recent part of the
 * conversation that fits, and what to do next.
 */
export function handoffPrompt(events, source, limit) {
    const title = source.title?.trim() ? ` “${source.title.trim().slice(0, 200)}”` : '';
    const intro = `I am continuing a conversation${title} from another machine, ${source.machine.slice(0, 100)}. It worked in this same SSH workspace, ${source.workspace}. `
        + 'Its history so far is below. Tool calls show only their names and tool results are left out, so check the current state of files before relying on it.';
    const note = source.note?.trim() || DEFAULT_NOTE;
    const budget = limit - intro.length - note.length - 200;
    const kept = [];
    const entries = conversationEntries(events);
    let used = 0, index = entries.length - 1;
    for (; index >= 0; index--) {
        const text = render(entries[index]);
        if (used + text.length + 2 > budget)
            break;
        kept.unshift(text);
        used += text.length + 2;
    }
    if (index >= 0)
        kept.unshift(`[${index + 1} earlier ${index === 0 ? 'message' : 'messages'} left out]`);
    if (!entries.length)
        kept.push('[No messages yet]');
    return `${intro}\n\n<previous-conversation>\n${kept.join('\n\n')}\n</previous-conversation>\n\n${note}`;
}
