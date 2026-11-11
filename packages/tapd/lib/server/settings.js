/** What the TAPD source keeps: how to sign in, whose bugs to fetch, and what to write back. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export const defaultSettings = () => ({ apiBase: 'https://api.tapd.cn', auth: { kind: 'bearer', token: '' }, owner: '', workspaces: [], statuses: ['new', 'reopened'], doneStatus: 'resolved', inProgressStatus: '', commentOnReview: true });
const str = (value, what, max = 500) => {
    if (typeof value !== 'string' || value.length > max)
        throw new Error(`${what} must be text of at most ${max} characters`);
    return value.trim();
};
/** Settings as a person typed them, checked; throws what to fix. */
export function settingsFrom(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Settings are missing');
    const input = raw, base = defaultSettings(), auth = (input.auth && typeof input.auth === 'object' ? input.auth : base.auth);
    const apiBase = str(input.apiBase ?? base.apiBase, 'API address', 300).replace(/\/+$/u, '');
    if (!/^https?:\/\/[^\s/]+/u.test(apiBase))
        throw new Error('The API address must start with http:// or https://');
    const statuses = input.statuses ?? base.statuses;
    if (!Array.isArray(statuses) || statuses.length > 30)
        throw new Error('Statuses must be a list of at most 30 entries');
    return {
        apiBase,
        auth: auth.kind === 'basic'
            ? { kind: 'basic', user: str(auth.user ?? '', 'API account', 200), token: str(auth.token ?? '', 'API password') }
            : { kind: 'bearer', token: str(auth.token ?? '', 'Access token') },
        owner: str(input.owner ?? '', 'Your TAPD name', 200),
        workspaces: (Array.isArray(input.workspaces) ? input.workspaces : []).slice(0, 100).map(entry => {
            const workspace = (entry ?? {}), id = str(String(workspace.id ?? ''), 'TAPD project ID', 40);
            if (!/^\d+$/u.test(id))
                throw new Error('A TAPD project ID is a number');
            return { id, name: str(workspace.name ?? '', 'TAPD project name', 100) };
        }),
        statuses: [...new Set(statuses.map(status => str(status, 'A status', 100)).filter(Boolean))],
        doneStatus: str(input.doneStatus ?? base.doneStatus, 'Done status', 100),
        inProgressStatus: str(input.inProgressStatus ?? '', 'In progress status', 100),
        commentOnReview: input.commentOnReview !== false,
    };
}
export const publicSettings = (settings) => ({ ...settings, auth: { ...settings.auth, token: '' }, hasToken: !!settings.auth.token });
export class SettingsStore {
    path;
    settings = defaultSettings();
    constructor(path) {
        this.path = path;
    }
    async open() {
        try {
            this.settings = settingsFrom(JSON.parse(await readFile(this.path, 'utf8')));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error(`The TAPD settings file could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** An empty token keeps the saved one: a page never receives it, so it cannot send it back. */
    async save(raw) {
        const next = settingsFrom(raw), saved = this.settings.auth;
        if (!next.auth.token && saved.kind === next.auth.kind)
            next.auth = { ...next.auth, token: saved.token };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.tmp`;
        // The file holds the token: the owner's eyes only.
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
        this.settings = next;
    }
}
