const SHARED = new Set([
    'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end',
    'session/title', 'approval/asked', 'approval/decided', 'model/selection', 'session/end-seed',
]);
const asDict = (value) => (typeof value === 'object' && value !== null ? value : {});
/** The shared form of one event, or undefined when it stays on its machine. */
export function shareEvent(event) {
    if (!SHARED.has(event.type))
        return undefined;
    let data = event.data;
    if (event.type === 'assistant/message') {
        const { stream: _stream, ...rest } = asDict(data);
        data = rest;
    }
    return { type: event.type, seq: event.seq, time: event.time, data };
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
/** Text of an assistant stream chunk, by kind. */
export function chunkText(chunk) {
    const value = asDict(chunk);
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
