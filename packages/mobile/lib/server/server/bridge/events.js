const SHARED = new Set([
    'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end',
    'session/title', 'approval/asked', 'approval/decided', 'model/selection',
]);
const asDict = (value) => (typeof value === 'object' && value !== null ? value : {});
/** The shared form of one event, or undefined when it stays on its machine. */
export function shareEvent(event) {
    if (!SHARED.has(event.type))
        return undefined;
    let data = event.data;
    if (event.type === 'user/message') {
        // DSH injects context as user messages (instructions, skill catalog, runtime and time snapshots); its own view
        // hides them, and they can be large.
        if (isInjected(data))
            return undefined;
    }
    else if (event.type === 'assistant/message') {
        const { stream: _stream, ...rest } = asDict(data);
        const message = asDict(rest.message), source = asDict(message.source);
        // The provider's replay state is for resuming the model, not for reading.
        data = message.source ? { ...rest, message: { ...message, source: { kind: source.kind, provider: source.provider, model: source.model } } } : rest;
    }
    return { type: event.type, seq: event.seq, time: event.time, data };
}
/** A user message DSH added as context rather than one a person sent. */
export function isInjected(data) {
    const source = asDict(asDict(data).source);
    return typeof source.form === 'string' || (typeof source.kind === 'string' && /-(context|catalog|instructions)$/.test(source.kind));
}
/** Text of the first message a person sent, as DSH's sidebar shows a session without a title. */
export function firstPrompt(events) {
    for (const event of events) {
        if (event.type !== 'user/message' || isInjected(event.data))
            continue;
        const data = asDict(event.data), content = data.content ?? asDict(data.message).content;
        const text = (Array.isArray(content) ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).join(' ') : typeof content === 'string' ? content : '').replace(/\s+/g, ' ').trim();
        if (text)
            return text.slice(0, 120);
    }
    return undefined;
}
/** Images and files a shared event refers to. */
export function attachmentRefs(event) {
    const content = asDict(asDict(event.data).message).content ?? asDict(event.data).content;
    if (!Array.isArray(content))
        return [];
    const refs = [];
    for (const block of content) {
        const { type, attachment } = asDict(block);
        const ref = asDict(attachment);
        if ((type === 'image' || type === 'file') && typeof ref.attachmentId === 'string') {
            refs.push({ ...ref, attachmentId: ref.attachmentId, kind: type,
                mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : undefined,
                name: typeof ref.name === 'string' ? ref.name : undefined,
                bytes: typeof ref.bytes === 'number' ? ref.bytes : undefined });
        }
    }
    return refs;
}
/**
 * The model a session uses: its latest `model/selection`, or the model that wrote its latest reply when it never chose
 * one (a session on DSH's default).
 */
export function modelOf(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'assistant/message') {
            const source = asDict(asDict(asDict(events[i].data).message).source);
            if (typeof source.provider === 'string' && typeof source.model === 'string')
                return { provider: source.provider, model: source.model };
            continue;
        }
        if (events[i].type !== 'model/selection')
            continue;
        const data = asDict(events[i].data), selection = data.provider ? data : asDict(data.selection ?? data.next ?? data.model);
        if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
            return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}) };
        }
    }
    return undefined;
}
/** Text of the latest assistant message, for a notification. */
export function lastAssistantText(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type !== 'assistant/message')
            continue;
        const content = asDict(asDict(events[i].data).message).content;
        const text = Array.isArray(content) ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).join('').trim() : '';
        if (text)
            return text;
    }
    return undefined;
}
/** Latest title in a log. */
export function titleOf(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'session/title') {
            const title = asDict(events[i].data).title;
            if (typeof title === 'string' && title.trim())
                return title;
        }
    }
    return undefined;
}
/** Approvals asked in a log and not yet decided. They show as waiting even when this plugin cannot answer them. */
export function openApprovals(events) {
    const open = new Map();
    for (const event of events) {
        // A turn that ended cannot still be waiting.
        if (event.type === 'turn/end') {
            open.clear();
            continue;
        }
        const data = asDict(event.data), id = typeof data.id === 'string' ? data.id : undefined;
        if (!id)
            continue;
        if (event.type === 'approval/asked') {
            open.set(id, { kind: 'approval', id, toolName: String(data.toolName ?? ''), askedAt: event.time, answerable: false,
                ...(typeof data.callId === 'string' ? { callId: data.callId } : {}), ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) });
        }
        else if (event.type === 'approval/decided')
            open.delete(id);
    }
    return [...open.values()];
}
/** DSH `userQuestions.active` entries still open, in the shared form. */
export function openQuestions(active, now = Date.now()) {
    if (!Array.isArray(active))
        return [];
    const result = [];
    for (const item of active) {
        const call = asDict(item);
        if (typeof call.callId !== 'string' || !Array.isArray(call.questions) || (call.state !== undefined && call.state !== 'open'))
            continue;
        const questions = call.questions.map(asDict).filter(q => typeof q.id === 'string' && typeof q.question === 'string').map(q => ({
            id: String(q.id), question: String(q.question),
            ...(typeof q.header === 'string' ? { header: q.header } : {}),
            ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
            ...(Array.isArray(q.options) ? { options: q.options.map(asDict).filter(o => typeof o.label === 'string').map(o => ({ label: String(o.label), ...(typeof o.description === 'string' ? { description: o.description } : {}) })) } : {}),
            ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
        }));
        if (questions.length > 0)
            result.push({ kind: 'question', id: call.callId, callId: call.callId, questions, askedAt: now });
    }
    return result;
}
/** Add one chunk of a reply being written, or one record of the compact form DSH keeps of it, to its draft, as DSH's chat does. */
export function addToDraft(draft, chunk) {
    const value = asDict(chunk);
    if (value.type === 'chunk')
        return addToDraft(draft, value.chunk);
    const blocks = draft.blocks ??= new Map(), index = typeof value.index === 'number' ? value.index : -1;
    if (value.type === 'block-start') {
        if (value.blockType === 'text')
            blocks.set(index, '');
        else
            blocks.delete(index);
    }
    else if (value.type === 'block-end') {
        const block = asDict(value.block);
        if (block.type === 'text' && typeof block.text === 'string')
            blocks.set(index, block.text);
        else
            blocks.delete(index);
    }
    else {
        const { text, reasoning } = chunkText(value);
        if (text) {
            blocks.set(index, (blocks.get(index) ?? '') + text);
            draft.reasoning = '';
        }
        if (reasoning)
            draft.reasoning += reasoning;
        if (!text)
            return;
    }
    // A CLI's narration between tool calls comes as separate blocks, which read as paragraphs once the reply is saved.
    draft.text = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).filter(Boolean).join('\n\n');
}
/** Text of an assistant stream chunk, by kind. */
function chunkText(value) {
    if (value.type === 'text-delta' && typeof value.text === 'string')
        return { text: value.text };
    if (value.type === 'reasoning-delta' && typeof value.text === 'string')
        return { reasoning: value.text };
    if (value.type === 'text-chunks' && Array.isArray(value.texts))
        return { text: value.texts.join('') };
    if (value.type === 'reasoning-chunks' && Array.isArray(value.texts))
        return { reasoning: value.texts.join('') };
    return {};
}
