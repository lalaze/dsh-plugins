/** What the TAPD source keeps: how to sign in, whose bugs to fetch, and what to write back. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Bug {
  id: string; workspaceId: string; title: string;
  /** As TAPD stores it: HTML. */
  description: string;
  owner: string; status: string; labels: string[]; module: string; priority: string;
}
export type TapdAuth = { kind: 'bearer'; token: string } | { kind: 'basic'; user: string; token: string };
export interface TapdSettings {
  apiBase: string;
  auth: TapdAuth;
  /** Whose bugs to fetch: the TAPD name in "current owner". */
  owner: string;
  workspaces: { id: string; name: string }[];
  /** Statuses to fetch, as API values (`new`) or as the workspace shows them (`待处理`). */
  statuses: string[];
  /** Written when a fix is accepted. */
  doneStatus: string;
  /** Written when a task starts; empty leaves the bug's status alone. */
  inProgressStatus: string;
  /** Whether a fix that waits for a person is said in a comment on the bug. */
  commentOnReview: boolean;
}
export const defaultSettings = (): TapdSettings => ({ apiBase: 'https://api.tapd.cn', auth: { kind: 'bearer', token: '' }, owner: '', workspaces: [], statuses: ['new', 'reopened'], doneStatus: 'resolved', inProgressStatus: '', commentOnReview: true });

const str = (value: unknown, what: string, max = 500): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${what} must be text of at most ${max} characters`);
  return value.trim();
};
/** Settings as a person typed them, checked; throws what to fix. */
export function settingsFrom(raw: unknown): TapdSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings are missing');
  const input = raw as Record<string, unknown>, base = defaultSettings(), auth = (input.auth && typeof input.auth === 'object' ? input.auth : base.auth) as Record<string, unknown>;
  const apiBase = str(input.apiBase ?? base.apiBase, 'API address', 300).replace(/\/+$/u, '');
  if (!/^https?:\/\/[^\s/]+/u.test(apiBase)) throw new Error('The API address must start with http:// or https://');
  const statuses = input.statuses ?? base.statuses;
  if (!Array.isArray(statuses) || statuses.length > 30) throw new Error('Statuses must be a list of at most 30 entries');
  return {
    apiBase,
    auth: auth.kind === 'basic'
      ? { kind: 'basic', user: str(auth.user ?? '', 'API account', 200), token: str(auth.token ?? '', 'API password') }
      : { kind: 'bearer', token: str(auth.token ?? '', 'Access token') },
    owner: str(input.owner ?? '', 'Your TAPD name', 200),
    workspaces: (Array.isArray(input.workspaces) ? input.workspaces : []).slice(0, 100).map(entry => {
      const workspace = (entry ?? {}) as Record<string, unknown>, id = str(String(workspace.id ?? ''), 'TAPD project ID', 40);
      if (!/^\d+$/u.test(id)) throw new Error('A TAPD project ID is a number');
      return { id, name: str(workspace.name ?? '', 'TAPD project name', 100) };
    }),
    statuses: [...new Set(statuses.map(status => str(status, 'A status', 100)).filter(Boolean))],
    doneStatus: str(input.doneStatus ?? base.doneStatus, 'Done status', 100),
    inProgressStatus: str(input.inProgressStatus ?? '', 'In progress status', 100),
    commentOnReview: input.commentOnReview !== false,
  };
}
/** Settings for a page: a saved secret is never sent back, only whether there is one. */
export type PublicSettings = TapdSettings & { hasToken: boolean };
export const publicSettings = (settings: TapdSettings): PublicSettings => ({ ...settings, auth: { ...settings.auth, token: '' }, hasToken: !!settings.auth.token });

export class SettingsStore {
  settings: TapdSettings = defaultSettings();
  constructor(private readonly path: string) {}
  async open(): Promise<void> {
    try { this.settings = settingsFrom(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`The TAPD settings file could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** An empty token keeps the saved one: a page never receives it, so it cannot send it back. */
  async save(raw: unknown): Promise<void> {
    const next = settingsFrom(raw), saved = this.settings.auth;
    if (!next.auth.token && saved.kind === next.auth.kind) next.auth = { ...next.auth, token: saved.token };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    // The file holds the token: the owner's eyes only.
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    this.settings = next;
  }
}
