/** Keep new Claude modes selectable in catalogs and sessions saved before an upgrade. */
export function permissionModes(provider, modes) {
    if (provider !== 'claude')
        return modes;
    const choices = modes.some(m => m.id === 'inherit') ? [...modes] : [{ id: 'inherit', label: 'Remote CLI settings' }, ...modes];
    if (!choices.some(m => m.id === 'auto'))
        choices.splice(choices.findIndex(m => m.id === 'inherit') + 1, 0, { id: 'auto', label: 'Auto · safety checks' });
    return choices;
}
export const inputModalitiesOf = (provider, model) => model.inputModalities ?? (['claude', 'codex'].includes(provider) ? ['text', 'image'] : ['text']);
export const PROVIDER_LABELS = { claude: 'Claude Code', codex: 'Codex', dsh: 'DSH', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy' };
/** Older machines retain their providers until the user explicitly changes the selection. */
export const enabledProvidersOf = (host) => host.enabledProviders ?? Object.keys(PROVIDER_LABELS);
export function providerSelection(value) {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !Object.hasOwn(PROVIDER_LABELS, id)))
        throw new RemoteError('Invalid CLI selection');
    return [...new Set(value)];
}
export const busy = (agent) => agent.status === 'starting' || agent.status === 'running' || agent.status === 'attention';
export class RemoteError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RemoteError('Expected a JSON object');
    return value;
}
export function field(value, label, max = 4096) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r]/.test(value))
        throw new RemoteError(`Invalid ${label}`);
    return value.trim();
}
export function identifier(value) {
    const id = field(value, 'request ID', 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(id))
        throw new RemoteError('Invalid request ID');
    return id;
}
export function remotePath(value) {
    const path = field(value, 'remote project path');
    if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(path) || /[\n]/.test(path))
        throw new RemoteError('Enter an absolute remote project path');
    return path;
}
export function taskInput(value) {
    const v = record(value);
    return {
        id: identifier(v.id), hostId: identifier(v.hostId), cwd: remotePath(v.cwd),
        provider: field(v.provider, 'provider', 200), model: field(v.model, 'model', 500),
        prompt: field(v.prompt, 'prompt', 100_000),
        ...(v.attachments !== undefined ? { attachments: attachmentInput(v.attachments) } : {}),
        ...(v.modeId ? { modeId: field(v.modeId, 'mode', 200) } : {}),
        ...(v.thinkingOptionId ? { thinkingOptionId: field(v.thinkingOptionId, 'thinking level', 200) } : {}),
        ...(v.serviceTier ? { serviceTier: field(v.serviceTier, 'speed', 200) } : {}),
    };
}
export function attachmentInput(value) {
    if (!Array.isArray(value) || value.length > 100)
        throw new RemoteError('Up to 100 attachments can be sent at once');
    return value.map(raw => {
        const a = record(raw);
        if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 0 || !['image', 'file'].includes(String(a.kind)))
            throw new RemoteError('Invalid attachment');
        if (a.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(a.mediaType)))
            throw new RemoteError('Unsupported image format');
        if (a.kind === 'image' && Number(a.bytes) > 5_000_000)
            throw new RemoteError('An image exceeds the 5 MB CLI input limit');
        return { sha256: a.sha256, name: field(a.name, 'attachment name', 255), bytes: Number(a.bytes), kind: a.kind, ...(a.kind === 'image' ? { mediaType: String(a.mediaType) } : {}) };
    });
}
export function cursorInput(value) {
    if (value === undefined || value === null)
        return;
    const v = record(value);
    if (!Number.isSafeInteger(v.seq) || Number(v.seq) < 0)
        throw new RemoteError('Invalid timeline cursor');
    return { epoch: field(v.epoch, 'timeline epoch', 200), seq: Number(v.seq) };
}
export function questionsOf(input) {
    if (!Array.isArray(input?.questions) || !input.questions.length)
        return [];
    const questions = [];
    for (const raw of input.questions) {
        if (!raw || typeof raw !== 'object')
            return [];
        const q = raw;
        if (typeof q.header !== 'string' || typeof q.question !== 'string' || !Array.isArray(q.options))
            return [];
        const options = q.options.filter((o) => !!o && typeof o === 'object' && typeof o.label === 'string');
        if (options.length !== q.options.length)
            return [];
        questions.push({ header: q.header, question: q.question, options, multiple: q.multiSelect === true, freeText: !options.length || q.allowOther === true || q.isOther === true, optional: q.allowEmpty === true });
    }
    return questions;
}
