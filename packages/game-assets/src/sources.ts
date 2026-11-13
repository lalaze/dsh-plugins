/**
 * Image sources: the image APIs the user has set up, kept with their keys in one private file of the DSH home, and the
 * call that asks one of them for a picture. Keys never leave the host: the client sees a source without its key, and an
 * API's error text is cleaned of it before it is passed on.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SOURCE_KINDS, usesApi, type Aspect, type SourceKind, type SourcesAnswer, type SourceView } from './domain.js';
import { imageSize, rasterType } from './images.js';
import { AssetError } from './workspace.js';

export interface ImageSource { id: string; name: string; kind: SourceKind; baseUrl: string; model: string; apiKey: string }
/** Sources one DSH keeps. */
export const SOURCE_LIMIT = 20;

export const viewOf = ({ apiKey, ...source }: ImageSource): SourceView => ({ ...source, keyHint: apiKey ? `…${apiKey.slice(-4)}` : '' });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A source as it may be saved, from what the client sent. A source being edited keeps its saved key unless a new one is
 * given; an empty key is allowed, for a local or relay endpoint that needs none.
 */
export function cleanSource(value: unknown, previous?: ImageSource): Omit<ImageSource, 'id'> {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 60 || CONTROL.test(name)) throw new AssetError('Give the source a name of up to 60 characters');
  if (!SOURCE_KINDS.includes(input.kind as SourceKind)) throw new AssetError('Unknown kind of image API');
  const model = typeof input.model === 'string' ? input.model.trim().replace(/^models\//, '') : '';
  if (model.length > 200 || /[\s/?#]/.test(model) || CONTROL.test(model)) throw new AssetError('Name the model, such as gpt-image-2');
  // Codex has no address and no key: it uses the login of the Codex CLI on the machine it runs on.
  if (!usesApi(input.kind as SourceKind)) return { name, kind: input.kind as SourceKind, baseUrl: '', model, apiKey: '' };
  const raw = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new AssetError('The address must be a full http:// or https:// URL'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || raw.length > 2048 || url.username || url.password || url.hash) throw new AssetError('The address must be a full http:// or https:// URL');
  if (!model) throw new AssetError('Name the model, such as gpt-image-2');
  let apiKey = previous?.apiKey ?? '';
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || CONTROL.test(input.apiKey.trim())) throw new AssetError('Invalid API key');
    apiKey = input.apiKey.trim();
  }
  return { name, kind: input.kind as SourceKind, baseUrl: raw.replace(/\/+$/, ''), model, apiKey };
}

interface Saved { defaultId: string | null; sources: ImageSource[] }
const empty = (): Saved => ({ defaultId: null, sources: [] });

/** The user's image sources, in one JSON file only its owner may read. */
export class SourceStore {
  private loaded: Promise<Saved> | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private load(): Promise<Saved> {
    return this.loaded ??= readFile(this.file, 'utf8').then(text => {
      const raw = JSON.parse(text) as { defaultId?: unknown; sources?: unknown };
      const saved = empty();
      for (const entry of Array.isArray(raw.sources) ? raw.sources : []) {
        try {
          if (typeof entry?.id !== 'string' || !entry.id) continue;
          saved.sources.push({ id: entry.id, ...cleanSource(entry) });
        } catch { /* skip a damaged entry */ }
      }
      saved.defaultId = saved.sources.some(source => source.id === raw.defaultId) ? raw.defaultId as string : saved.sources[0]?.id ?? null;
      return saved;
    }).catch(empty);
  }
  private async save(change: (saved: Saved) => void): Promise<SourcesAnswer> {
    const saved = await this.load();
    change(saved);
    if (!saved.sources.some(source => source.id === saved.defaultId)) saved.defaultId = saved.sources[0]?.id ?? null;
    const write = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, ...saved }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
    this.writing = write;
    await write;
    return this.answer(saved);
  }
  private answer(saved: Saved): SourcesAnswer { return { sources: saved.sources.map(viewOf), defaultId: saved.defaultId }; }

  async list(): Promise<SourcesAnswer> { return this.answer(await this.load()); }
  /** The source to generate with: the one named, or else the default. */
  async get(id?: unknown): Promise<ImageSource> {
    const saved = await this.load();
    if (!saved.sources.length) throw new AssetError('Add an image source first', 409);
    const source = saved.sources.find(entry => entry.id === (typeof id === 'string' && id ? id : saved.defaultId));
    if (!source) throw new AssetError('That image source was removed', 404);
    return source;
  }
  /** Adds a source, or changes the one with the given `id`. The first source becomes the default. */
  async put(value: unknown): Promise<SourcesAnswer & { id: string }> {
    const id = (value as { id?: unknown } | undefined)?.id;
    const saved = await this.load();
    const previous = typeof id === 'string' && id ? saved.sources.find(source => source.id === id) : undefined;
    if (typeof id === 'string' && id && !previous) throw new AssetError('That image source was removed', 404);
    if (!previous && saved.sources.length >= SOURCE_LIMIT) throw new AssetError('Up to 20 image sources can be kept');
    const source = { id: previous?.id ?? randomUUID(), ...cleanSource(value, previous) };
    const answer = await this.save(next => {
      const index = next.sources.findIndex(entry => entry.id === source.id);
      if (index >= 0) next.sources[index] = source; else next.sources.push(source);
    });
    return { ...answer, id: source.id };
  }
  remove(id: unknown): Promise<SourcesAnswer> { return this.save(saved => { saved.sources = saved.sources.filter(source => source.id !== id); }); }
  async setDefault(id: unknown): Promise<SourcesAnswer> {
    if (!(await this.load()).sources.some(source => source.id === id)) throw new AssetError('That image source was removed', 404);
    return this.save(saved => { saved.defaultId = id as string; });
  }
}

export interface Reference { name: string; data: Buffer; mediaType: string }
export interface GenerateInput { prompt: string; references: Reference[]; aspect: Aspect; transparent: boolean }
export interface Generated { data: Buffer; mediaType: string; width?: number; height?: number; text?: string }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Image models often take a minute or two; past this a generation is given up. */
export const GENERATE_TIMEOUT_MS = 300_000;
/** The largest answer read from an image API: a few large pictures in base64. */
const ANSWER_LIMIT = 96 * 1024 * 1024;
const OPENAI_SIZE: Record<Aspect, string> = { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' };
const GEMINI_RATIO: Record<Aspect, string> = { square: '1:1', wide: '3:2', tall: '2:3' };

/** `path` appended to the source's address, which may carry a query of its own. */
function endpoint(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
  return url.toString();
}

/** What an API said went wrong, without the key, cut to a readable length. */
function explain(text: string, key: string): string {
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    if (typeof message === 'string' && message.trim()) said = message;
  } catch { /* not JSON: an HTML error page or plain text */ }
  said = said.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (key.length >= 6) said = said.split(key).join('…');
  return said.length > 400 ? `${said.slice(0, 400)}…` : said;
}

async function readAnswer(response: Response, source: ImageSource): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > ANSWER_LIMIT) throw new AssetError('The image API answered with more than this plugin reads', 502);
  const text = await response.text();
  if (!response.ok) throw new AssetError(`${source.name} refused the request (${response.status}): ${explain(text, source.apiKey) || response.statusText || 'no reason given'}`, 502);
  if (text.length > ANSWER_LIMIT) throw new AssetError('The image API answered with more than this plugin reads', 502);
  try { return JSON.parse(text); } catch { throw new AssetError(`${source.name} did not answer with JSON: ${explain(text, source.apiKey).slice(0, 200)}`, 502); }
}

function picture(data: Buffer, text?: string): Generated {
  const type = rasterType(data);
  if (type !== 'png' && type !== 'jpeg' && type !== 'webp') throw new AssetError('The image API answered with something other than a PNG, JPEG or WebP picture', 502);
  return { data, mediaType: `image/${type}`, ...imageSize(data), ...(text ? { text } : {}) };
}

/** OpenAI's Images API: a plain generation without references, an edit with them. */
async function openai(source: ImageSource, input: GenerateInput, fetch: Fetch, signal: AbortSignal): Promise<Generated> {
  const auth: Record<string, string> = source.apiKey ? { authorization: `Bearer ${source.apiKey}` } : {};
  const fields: Record<string, string> = { model: source.model, prompt: input.prompt, size: OPENAI_SIZE[input.aspect], ...(input.transparent ? { background: 'transparent', output_format: 'png' } : {}) };
  let response: Response;
  if (!input.references.length) {
    response = await fetch(endpoint(source.baseUrl, 'images/generations'), { method: 'POST', signal, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, n: 1 }) });
  } else {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('n', '1');
    // One picture goes as `image`, as every compatible service takes; several as `image[]`.
    for (const reference of input.references) form.append(input.references.length > 1 ? 'image[]' : 'image', new Blob([new Uint8Array(reference.data)], { type: reference.mediaType }), reference.name);
    response = await fetch(endpoint(source.baseUrl, 'images/edits'), { method: 'POST', signal, headers: auth, body: form });
  }
  const answer = await readAnswer(response, source) as { data?: { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }[] };
  const item = answer?.data?.[0], text = typeof item?.revised_prompt === 'string' ? item.revised_prompt : undefined;
  if (typeof item?.b64_json === 'string' && item.b64_json) return picture(Buffer.from(item.b64_json, 'base64'), text);
  if (typeof item?.url === 'string' && /^https?:\/\//.test(item.url)) {
    // A link to the picture, as older models and some relays answer; the key is not sent along.
    const file = await fetch(item.url, { signal });
    if (!file.ok) throw new AssetError(`The picture could not be downloaded (${file.status})`, 502);
    if (Number(file.headers.get('content-length')) > ANSWER_LIMIT) throw new AssetError('The image API answered with more than this plugin reads', 502);
    return picture(Buffer.from(await file.arrayBuffer()), text);
  }
  throw new AssetError(`${source.name} answered without a picture`, 502);
}

/** Gemini's `generateContent`, asked for an image; references go first, as Google's examples send them. */
async function gemini(source: ImageSource, input: GenerateInput, fetch: Fetch, signal: AbortSignal): Promise<Generated> {
  const response = await fetch(endpoint(source.baseUrl, `models/${encodeURIComponent(source.model)}:generateContent`), {
    method: 'POST', signal, headers: { ...(source.apiKey ? { 'x-goog-api-key': source.apiKey } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [...input.references.map(reference => ({ inlineData: { mimeType: reference.mediaType, data: reference.data.toString('base64') } })), { text: input.prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: GEMINI_RATIO[input.aspect] } },
    }),
  });
  type Part = { text?: unknown; inlineData?: { data?: unknown }; inline_data?: { data?: unknown } };
  const answer = await readAnswer(response, source) as { candidates?: { content?: { parts?: Part[] }; finishReason?: unknown }[]; promptFeedback?: { blockReason?: unknown } };
  const parts = answer?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(part => typeof part.text === 'string' ? part.text : '').join('').trim() || undefined;
  const image = parts.map(part => part.inlineData?.data ?? part.inline_data?.data).find((data): data is string => typeof data === 'string' && !!data);
  if (image) return picture(Buffer.from(image, 'base64'), text);
  const reason = answer?.promptFeedback?.blockReason ?? answer?.candidates?.[0]?.finishReason;
  throw new AssetError(`${source.name} answered without a picture${typeof reason === 'string' ? ` (${reason})` : ''}${text ? `: ${text.slice(0, 300)}` : ''}`, 502);
}

/** Asks the source for one picture. `signal` stops it, as when the user closes the dialog. */
export async function generateImage(source: ImageSource, input: GenerateInput, options: { fetch?: Fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Generated> {
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error('timeout')), options.timeoutMs ?? GENERATE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const fetch = options.fetch ?? globalThis.fetch;
  if (!usesApi(source.kind)) throw new AssetError(`${source.name} does not answer over HTTP`, 500);
  try {
    return await (source.kind === 'gemini' ? gemini : openai)(source, input, fetch, signal);
  } catch (error) {
    if (error instanceof AssetError) throw error;
    if (timeout.signal.aborted) throw new AssetError('The image API took too long to answer', 504);
    if (options.signal?.aborted) throw new AssetError('Generation stopped', 499);
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const why = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : error instanceof Error ? error.message : String(error);
    throw new AssetError(`${new URL(source.baseUrl).host} could not be reached: ${explain(why, source.apiKey)}`, 502);
  } finally { clearTimeout(timer); }
}
