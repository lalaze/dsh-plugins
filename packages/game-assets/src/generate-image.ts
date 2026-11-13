/**
 * The script DSH Game Assets puts in a project as `.game-assets/generate-image.cjs`, for agents working there:
 * one picture from the project's image source, saved at a free path inside the project. Bundled into one file that
 * needs Node.js 18 or newer and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runCodex } from './codex.js';
import { KEYS_DIR, KEYS_FILE, PROJECT_SOURCE_FILE, REFERENCE_LIMIT, extensionOf, isReference, usesApi, type Aspect, type ProjectSource } from './domain.js';
import { Library, cleanImagePath } from './manage.js';
import { generateImage } from './sources.js';

const USAGE = `Usage: node ${PROJECT_SOURCE_FILE.replace('image-source.json', 'generate-image.cjs')} --prompt <text> --out <path> [--ref <image>]... [--shape square|wide|tall] [--transparent]

Generates one picture with the project's image source and saves it at --out, a new .png, .webp or .jpg file inside the
project. An existing file is never replaced. Prints {"path", "width", "height", "bytes", "source", "model"} as JSON.`;
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
const ASPECTS: readonly Aspect[] = ['square', 'wide', 'tall'];

class UsageError extends Error {}

export interface Options { prompt: string; out: string; refs: string[]; aspect: Aspect; transparent: boolean }
export async function parseArgs(argv: string[]): Promise<Options | 'help'> {
  const options: Partial<Options> & { refs: string[] } = { refs: [], aspect: 'square', transparent: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { const next = argv[++i]; if (next === undefined) throw new UsageError(`${arg} needs a value`); return next; };
    if (arg === '--help' || arg === '-h') return 'help';
    else if (arg === '--prompt') options.prompt = value();
    else if (arg === '--prompt-file') options.prompt = await readFile(value(), 'utf8');
    else if (arg === '--out') options.out = value();
    else if (arg === '--ref') options.refs.push(value());
    else if (arg === '--shape') { const shape = value(); if (!ASPECTS.includes(shape as Aspect)) throw new UsageError('--shape is square, wide or tall'); options.aspect = shape as Aspect; }
    else if (arg === '--transparent') options.transparent = true;
    else throw new UsageError(`Unknown option ${arg}`);
  }
  if (!options.prompt?.trim()) throw new UsageError('--prompt is required');
  if (!options.out) throw new UsageError('--out is required');
  if (options.refs.length > REFERENCE_LIMIT) throw new UsageError(`Up to ${REFERENCE_LIMIT} --ref images`);
  return { ...options, prompt: options.prompt.trim() } as Options;
}

/** The key of an API source: `DSH_IMAGE_API_KEY`, or the one DSH saved on this machine. */
async function keyOf(source: ProjectSource, home = homedir()): Promise<string> {
  const fromEnv = process.env.DSH_IMAGE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const keys = (JSON.parse(await readFile(join(home, KEYS_DIR, KEYS_FILE), 'utf8')) as { keys?: Record<string, { key?: unknown }> }).keys;
    const key = keys?.[source.id]?.key;
    if (typeof key === 'string') return key;
  } catch { /* none saved here */ }
  throw new Error(`No API key for "${source.name}" on this machine. Record the source for this project again in DSH's Assets tab, or set DSH_IMAGE_API_KEY.`);
}

/** Generates and saves; answers what to print. `root` is the project folder, the one that holds `.game-assets`. */
export async function generate(root: string, options: Options, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const source = JSON.parse(await readFile(join(root, PROJECT_SOURCE_FILE), 'utf8').catch(() => { throw new Error(`${PROJECT_SOURCE_FILE} is missing: choose an image source for this project in DSH's Assets tab.`); })) as ProjectSource;
  const inProject = (path: string, what: string) => {
    const rel = relative(root, resolve(cwd, path)).split('\\').join('/');
    if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) throw new UsageError(`${what} must be inside the project: ${path}`);
    return rel;
  };
  const refs = options.refs.map(path => { const rel = inProject(path, '--ref'); if (!isReference(rel)) throw new UsageError(`--ref takes PNG, WebP or JPEG images: ${path}`); return rel; });
  let out = cleanImagePath(inProject(options.out, '--out'));
  if (!out) throw new UsageError('--out must be a .png, .webp or .jpg file in a visible folder of the project');

  const picture = usesApi(source.kind)
    ? await generateImage({ ...source, apiKey: await keyOf(source) }, { prompt: options.prompt, aspect: options.aspect, transparent: options.transparent && source.kind !== 'gemini',
      references: await Promise.all(refs.map(async rel => { const data = await readFile(join(root, rel)); return { name: basename(rel), data, mediaType: `image/${extensionOf(rel) === 'jpg' ? 'jpeg' : extensionOf(rel)}` }; })) })
    : await runCodex({ prompt: options.prompt, references: refs.map(rel => join(root, rel)), aspect: options.aspect, transparent: options.transparent, model: source.model });

  // The file takes the picture's own format; a name that says otherwise is corrected rather than mislabelled.
  const extension = EXTENSION[picture.mediaType], wanted = extensionOf(out);
  let renamed = false;
  if (extension && wanted !== extension && !(extension === 'jpg' && wanted === 'jpeg')) { out = `${out.slice(0, out.length - wanted.length)}${extension}`; renamed = true; }
  const placed = await new Library(root).place(out, picture.data, false, '_retired');
  return { path: placed.path, width: picture.width, height: picture.height, bytes: picture.data.length, source: source.name, model: source.model || undefined, ...(renamed ? { note: `saved as .${extension}, the format the source made` } : {}) };
}

async function main(): Promise<void> {
  // Node.js uses HTTPS_PROXY only when told to; an API reached through a proxy needs it.
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(name => process.env[name]);
  if (proxied && !process.env.NODE_USE_ENV_PROXY) {
    const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    process.exit(again.status ?? 1);
  }
  try {
    const options = await parseArgs(process.argv.slice(2));
    if (options === 'help') { console.log(USAGE); return; }
    const root = await realpath(dirname(__dirname_()));
    console.log(JSON.stringify(await generate(root, options, await realpath(process.cwd()))));
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `generate-image: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
/** The script's folder, `.game-assets`; its parent is the project. */
const __dirname_ = () => typeof __dirname === 'string' ? __dirname : process.cwd();

if ((globalThis as { __DSH_GAME_ASSETS_SCRIPT__?: boolean }).__DSH_GAME_ASSETS_SCRIPT__) void main();
