/** TAPD's open API for bugs: the ones a person owns, one by ID, and writing a status or a comment back. */
import type { Bug, TapdSettings } from './settings.js';

type Json = Record<string, unknown>;
const PAGE = 100;
const MAX_PAGES = 50;
const MAX_IMAGE = 8 * 1024 * 1024;

const text = (value: unknown): string => value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
/** TAPD has two names for a status: the API value (`in_progress`) and what the workspace shows (`处理中`). */
export const isApiStatus = (value: string) => /^[A-Za-z0-9_-]+$/u.test(value);
export function statusQuery(statuses: readonly string[]): Record<string, string> {
  const wanted = [...new Set(statuses.map(status => status.trim()).filter(Boolean))], api = wanted.filter(isApiStatus), shown = wanted.filter(status => !isApiStatus(status));
  return api.length ? { status: api.join('|') } : shown.length ? { v_status: shown.join('|') } : {};
}
export const statusField = (status: string): Record<string, string> => ({ [isApiStatus(status) ? 'status' : 'v_status']: status });

function labelsOf(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(text) : text(value).split(/[;,|\n]/u);
  return parts.map(part => part.trim()).filter(Boolean);
}
export function parseBugs(payload: unknown): Bug[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap(item => {
    const raw = (item && typeof item === 'object' && 'Bug' in item ? (item as { Bug: unknown }).Bug : item) as Json | null;
    if (!raw || typeof raw !== 'object') return [];
    const bug: Bug = {
      id: text(raw.id), workspaceId: text(raw.workspace_id), title: text(raw.title) || text(raw.name), description: text(raw.description),
      owner: text(raw.current_owner), status: text(raw.status), labels: labelsOf(raw.label ?? raw.labels), module: text(raw.module), priority: text(raw.priority),
    };
    return bug.id && bug.workspaceId ? [bug] : [];
  });
}
function check(payload: unknown): void {
  const { status, info, message } = (payload ?? {}) as Json;
  const ok = status === undefined || status === 1 || status === '1' || status === 'success' || status === true;
  if (!ok) throw new Error(`TAPD refused the request: ${text(info ?? message ?? payload).slice(0, 500)}`);
}

const decodeAttribute = (value: string) => value.replace(/&amp;/gu, '&').replace(/&quot;|&#34;/gu, '"').replace(/&#39;|&apos;/gu, "'");
const IMG = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu;
/** The pictures in a bug's description, in order, each once. */
export function imageSources(description: string): string[] {
  const found = new Set<string>();
  for (const match of description.matchAll(IMG)) {
    const source = decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (source && !/^(?:data|cid|file):/iu.test(source)) found.add(source);
  }
  return [...found];
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A description as plain text for a model: paragraphs kept, pictures as `[image N]` in their place. */
export function descriptionText(description: string): string {
  const sources = imageSources(description);
  return description
    .replace(/<img\b[^>]*>/giu, tag => {
      const match = new RegExp(IMG.source, 'iu').exec(tag), source = match ? decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '').trim() : '', index = sources.indexOf(source);
      return index < 0 ? '' : ` [image ${index + 1}] `;
    })
    .replace(/<\s*br\s*\/?>|<\/\s*(?:p|div|li|tr|h[1-6])\s*>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '- ')
    .replace(/<[^>]+>/gu, '')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/giu, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').replace(/[ \t]{2,}/gu, ' ').trim();
}

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function sniff(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return undefined;
}
export interface TapdImage { bytes: Uint8Array; mediaType: string; extension: string }

export class TapdClient {
  constructor(private readonly settings: () => TapdSettings, private readonly fetcher: typeof fetch = fetch) {}

  private authorization(): string {
    const { auth } = this.settings();
    if (!auth.token) throw new Error('TAPD is not signed in: add the access token in Settings → TAPD');
    return auth.kind === 'basic' ? `Basic ${Buffer.from(`${auth.user}:${auth.token}`).toString('base64')}` : `Bearer ${auth.token}`;
  }
  private async request(method: 'GET' | 'POST', path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(this.settings().apiBase.replace(/\/+$/u, '') + path);
    if (method === 'GET') for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json', Authorization: this.authorization(), ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: new URLSearchParams(fields).toString() } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`TAPD could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`TAPD answered ${response.status} without JSON${response.status === 401 || response.status === 403 ? ': check the access token' : ''}`); }
    check(payload);
    if (!response.ok) throw new Error(`TAPD answered ${response.status}`);
    return payload;
  }

  /** The owner's bugs in the chosen statuses, across the configured TAPD projects. */
  async listBugs(signal?: AbortSignal): Promise<Bug[]> {
    const settings = this.settings();
    if (!settings.owner) throw new Error('Say whose bugs to fetch: the owner in Settings → TAPD');
    if (!settings.workspaces.length) throw new Error('Add a TAPD project in Settings → TAPD');
    const bugs: Bug[] = [];
    for (const workspace of settings.workspaces) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const found = parseBugs(await this.request('GET', '/bugs', { workspace_id: workspace.id, current_owner: settings.owner, limit: String(PAGE), page: String(page), ...statusQuery(settings.statuses) }, signal));
        bugs.push(...found);
        if (found.length < PAGE) break;
      }
    }
    return bugs;
  }
  async getBug(workspaceId: string, id: string, signal?: AbortSignal): Promise<Bug | undefined> {
    return parseBugs(await this.request('GET', '/bugs', { workspace_id: workspaceId, id, limit: '1' }, signal)).find(bug => bug.id === id && bug.workspaceId === workspaceId);
  }
  /** A status, a comment, or both. */
  async update(bug: Pick<Bug, 'id' | 'workspaceId'>, change: { status?: string; comment?: string }, signal?: AbortSignal): Promise<void> {
    const fields = { workspace_id: bug.workspaceId, id: bug.id, ...(change.status ? statusField(change.status) : {}), ...(change.comment ? { comment: change.comment } : {}) };
    await this.request('POST', '/bugs', fields, signal);
  }
  /** Where a description's picture really is. TAPD writes its own as `/tfl/…`, served by the web site, not the API. */
  imageUrl(source: string): URL | undefined {
    const api = new URL(this.settings().apiBase);
    try {
      if (source.startsWith('//')) return new URL(`https:${source}`);
      if (/^https?:\/\//iu.test(source)) return new URL(source);
      const web = new URL(api.origin);
      if (['api.tapd.cn', 'apiv2.tapd.tencent.com', 'api.tapd.tencent.com'].includes(web.hostname)) web.hostname = 'www.tapd.cn';
      return new URL(source, source.startsWith('/tfl/') ? web : api);
    } catch { return undefined; }
  }
  /** One picture; undefined when it is not a picture a model can read. The sign-in goes only to TAPD's own hosts. */
  async image(source: string, signal?: AbortSignal): Promise<TapdImage | undefined> {
    const url = this.imageUrl(source);
    if (!url) return undefined;
    const host = url.hostname.toLowerCase(), own = host === new URL(this.settings().apiBase).hostname.toLowerCase() || /(^|\.)tapd\.cn$|(^|\.)tapd\.tencent\.com$/u.test(host);
    const response = await this.fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { Accept: 'image/png,image/jpeg,image/webp,*/*', ...(own ? { Authorization: this.authorization() } : {}) } });
    if (!response.ok) throw new Error(`The picture answered ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_IMAGE) throw new Error('The picture is too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE) throw new Error('The picture is too large');
    const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mediaType = IMAGE_TYPES[declared] ? (declared === 'image/jpg' ? 'image/jpeg' : declared) : sniff(bytes);
    return mediaType ? { bytes, mediaType, extension: IMAGE_TYPES[mediaType] } : undefined;
  }
}
/** The bug's page for a person. */
export const bugUrl = (bug: Pick<Bug, 'id' | 'workspaceId'>) => `https://www.tapd.cn/${bug.workspaceId}/bugtrace/bugs/view?bug_id=${bug.id}`;
