/**
 * Generating a picture with the Codex CLI that is signed in on this machine, through its built-in image tool. No key is
 * needed: Codex uses its own login. Runs on the DSH host for a local workspace, inside the remote script for a remote
 * one, and in the project's generate-image script.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Aspect } from './domain.js';
import { imageSize, rasterType } from './images.js';
import { AssetError } from './workspace.js';

export interface CodexRequest {
  prompt: string;
  /** Absolute paths of reference images. */
  references: string[];
  aspect: Aspect;
  transparent: boolean;
  /** The model that drives Codex; Codex's default when empty. The picture itself always comes from Codex's image tool. */
  model?: string;
}
export interface CodexOptions {
  /** Starts Codex through the user's login shell, for a process whose PATH may not reach it, such as DSH started from the Dock. */
  loginShell?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The command to run; tests put a stand-in here. */
  command?: string;
}
export interface CodexPicture { data: Buffer; mediaType: string; width?: number; height?: number; text?: string }

export const CODEX_TIMEOUT_MS = 300_000;
const SHAPE: Record<Aspect, string> = { square: 'square (1:1)', wide: 'landscape (3:2)', tall: 'portrait (2:3)' };
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** What Codex is asked: one picture from its image tool, nothing else. */
export function codexPrompt(request: CodexRequest): string {
  return [
    `Use your image generation tool to create exactly one image, ${SHAPE[request.aspect]}${request.transparent ? ', on a transparent background' : ''}.`,
    request.references.length ? `The attached image${request.references.length > 1 ? 's are references' : ' is the reference'} for it.` : '',
    'Do not run commands, read or write files, or ask questions. When the image is done, reply with one short sentence.',
    '', 'Image request:', request.prompt,
  ].filter((line, i) => line || i > 1).join('\n');
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const codexHome = () => process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

/** The newest picture Codex saved for a thread, from `generated_images/<thread>/`. */
async function savedPicture(thread: string): Promise<Buffer | undefined> {
  const dir = join(codexHome(), 'generated_images', thread);
  const files = await readdir(dir).catch(() => [] as string[]);
  let newest: { file: string; time: number } | undefined;
  for (const name of files) {
    if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
    const time = (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0;
    if (!newest || time > newest.time) newest = { file: join(dir, name), time };
  }
  return newest ? readFile(newest.file) : undefined;
}

/** Runs `codex exec` once and answers the picture it made. */
export async function runCodex(request: CodexRequest, options: CodexOptions = {}): Promise<CodexPicture> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-game-assets-codex-'));
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work,
    ...(request.model ? ['--model', request.model] : []), ...request.references.flatMap(file => ['--image', file])];
  const command = options.command ?? 'codex';
  const [file, argv] = options.loginShell
    ? [process.env.SHELL?.trim() || '/bin/sh', ['-lc', `exec ${[command, ...args].map(quote).join(' ')}`]]
    : [command, args];
  const lines: string[] = [];
  let stderr = '', size = 0, timedOut = false;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(file, argv, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      const stop = () => child.kill('SIGTERM');
      const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? CODEX_TIMEOUT_MS);
      options.signal?.addEventListener('abort', stop, { once: true });
      let pending = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if ((size += chunk.length) > OUTPUT_LIMIT) return;
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        lines.push(...parts);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', exit => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); if (pending) lines.push(pending); resolve(exit); });
      child.stdin.on('error', () => {});
      child.stdin.end(codexPrompt(request));
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AssetError('Codex was not found on this machine. Install the Codex CLI and run codex login there', 502);
      throw error;
    });
    if (options.signal?.aborted) throw new AssetError('Generation stopped', 499);
    if (timedOut) throw new AssetError('Codex took too long to answer', 504);

    let thread: string | undefined, failure: string | undefined, text: string | undefined, inline: string | undefined;
    for (const line of lines) {
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') thread = event.thread_id;
      if (event.type === 'error' && typeof event.message === 'string') failure = event.message;
      if (event.type === 'turn.failed' && typeof event.error?.message === 'string') failure = event.error.message;
      const item = event.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
      // However this Codex reports the image item, its picture may come inline.
      if (typeof item?.result === 'string' && item.result.length > 100) inline = item.result;
    }
    const data = (inline ? Buffer.from(inline, 'base64') : undefined) ?? (thread ? await savedPicture(thread) : undefined);
    if (!data) {
      if (/command not found|not found: codex/.test(stderr)) throw new AssetError('Codex was not found on this machine. Install the Codex CLI and run codex login there', 502);
      const said = failure ?? text ?? stderr.split('\n').map(line => line.trim()).filter(line => line && !/^\d{4}-\d\d-\d\dT.*\b(WARN|INFO|DEBUG)\b/.test(line)).slice(-3).join(' ');
      throw new AssetError(`Codex made no picture${code ? ` (exit ${code})` : ''}: ${said.slice(0, 400) || 'no reason given'}`, 502);
    }
    const type = rasterType(data);
    if (type !== 'png' && type !== 'jpeg' && type !== 'webp') throw new AssetError('Codex answered with something other than a PNG, JPEG or WebP picture', 502);
    return { data, mediaType: `image/${type}`, ...imageSize(data), ...(text ? { text } : {}) };
  } finally { await rm(work, { recursive: true, force: true }); }
}
