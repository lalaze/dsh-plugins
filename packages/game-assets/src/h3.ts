/**
 * Running `h3` (MiniMax-H3-Image on Google Colab) on the DSH host for batch redraws.
 *
 * Interface checked against `h3 --help`, `h3 up --help`, `h3 edit --help`, `h3 status --help` and `h3 down --help`
 * on 2026-11-17:
 * - Status: `h3 status`
 *   Exits 0 when the Colab session (`h3`, or `H3_SESSION`) is running; exits 1 with
 *   `没有名为 'h3' 的 Colab 会话` (or `Session ... not found` / `No active sessions`) when no VM is up.
 * - Boot: `h3 up`
 *   Boots an A100 Colab VM, installs ComfyUI, downloads MiniMax-H3-Image weights and starts ComfyUI (~11 min, ~1.6 CU).
 * - Draw one picture from its reference: `h3 edit --mp 16 -o <outDir> --json -- <prompt> <reference>`
 *   Uses 16 MP final quality (`--mp 16`), writes the PNG and `.json` metadata into `<outDir>`, and prints JSON Lines on
 *   stdout (`{"event":"image","ok":true,"path":"/abs/x.png","width":...,"height":...}`,
 *   `{"event":"image","ok":false,"error":"..."}`, `{"event":"done",...}`, `{"event":"error","error":"..."}`) while human
 *   progress goes to stderr; exits 0 when every image succeeded, non-zero otherwise.
 *   `h3 edit` names input images `<Picture 1>`, `<Picture 2>`, … in the prompt, so `<Picture 1> ` is prepended when the
 *   prompt does not already mention `<Picture 1>`.
 *   `h3 gen -f` is text-to-image only, and `h3 edit <prompt> a.png b.png` combines several references into one picture
 *   rather than redrawing each separately, so a batch redraw calls `h3 edit` once per image while the VM stays up.
 *   `h3 edit` takes neither `--aspect` nor a transparent-background flag; its pictures are opaque PNGs.
 * - Shut down: `h3 down`
 *   Stops the Colab VM so CU billing ends; always run in `finally`, even after a failed `up`, a failed `edit`, or a stop.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Aspect } from './domain.js';
import { imageSize, rasterType } from './images.js';
import { AssetError } from './workspace.js';

export const H3_BOOT_TIMEOUT_MS = 20 * 60_000;
export const H3_DRAW_TIMEOUT_MS = 10 * 60_000;
export const H3_DOWN_TIMEOUT_MS = 2 * 60_000;
export const H3_STATUS_TIMEOUT_MS = 60_000;

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const NO_SESSION = /没有名为.*会话|未找到.*会话|会话.*不存在|没有活动.*会话|Session\s+['"]?[^'"]+['"]?\s+not found|No active (?:colab )?(?:sessions?|runtimes?)/i;
const MISSING_H3 = /(?:^|\b)(?:command not found|not found):?\s*.*h3\b|h3:\s*(?:command )?not found/i;
const AUTH_FAILURE = /找不到\s*`?colab`?\s*命令|完成\s*Google\s*账号授权|oauth2|unauthenticated|credentials?\b.*(?:expired|missing|invalid)|re-?authenticate/i;

/** An error that means the h3 installation, authorization or Colab VM itself is unavailable for the rest of the batch. */
export class H3FatalError extends AssetError {}

export interface H3Options {
  /** Starts h3 through the user's login shell (default true), as DSH launched from the Dock may not have ~/.local/bin in PATH. */
  loginShell?: boolean;
  /** The executable to run; tests pass a stand-in script here. */
  command?: string;
  bootTimeoutMs?: number;
  drawTimeoutMs?: number;
  downTimeoutMs?: number;
  statusTimeoutMs?: number;
}

export interface H3DrawRequest {
  prompt: string;
  /** Absolute path of the reference image staged on the DSH host. */
  reference: string;
  aspect: Aspect;
  transparent: boolean;
  /** Folder on the DSH host where `h3 edit -o` writes its PNG and metadata. */
  outDir: string;
}

export interface H3Picture {
  file: string;
  data: Buffer;
  mediaType: string;
  width?: number;
  height?: number;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Formats the shared prompt for `h3 edit`, which refers to its reference image as `<Picture 1>`. */
export function h3Prompt(prompt: string): string {
  const clean = prompt.trim();
  return /<Picture\s*1>/i.test(clean) ? clean : `<Picture 1> ${clean}`;
}

function tail(text: string): string {
  const said = text
    .split('\n')
    .map(line => line.trim().replace(/^h3:\s*/i, ''))
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return said.length > 400 ? `${said.slice(0, 400)}…` : said;
}

interface RunOutput {
  code: number | null;
  stdout: string;
  lines: string[];
  stderr: string;
}

async function runH3(args: string[], timeoutMs: number, timeoutMessage: string, options: H3Options = {}, signal?: AbortSignal): Promise<RunOutput> {
  if (signal?.aborted) throw new AssetError('Generation stopped', 499);
  const command = options.command ?? 'h3';
  const [file, argv] = (options.loginShell ?? true)
    ? [process.env.SHELL?.trim() || '/bin/sh', ['-lc', `exec ${[command, ...args].map(quote).join(' ')}`]]
    : [command, args];
  const lines: string[] = [];
  let stdout = '', stderr = '', size = 0, timedOut = false;
  const groupKill = process.platform !== 'win32';
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: groupKill });
    const stop = () => {
      if (groupKill && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* fall back to direct kill */ }
      }
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if ((size += chunk.length) > OUTPUT_LIMIT) return;
      stdout = (stdout + chunk).slice(-32_000);
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      lines.push(...parts);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', exit => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (pending) lines.push(pending);
      resolve(exit);
    });
  }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new H3FatalError('h3 was not found on this machine', 502);
    throw error;
  });
  if (signal?.aborted) throw new AssetError('Generation stopped', 499);
  if (timedOut) throw new AssetError(timeoutMessage, 504);
  if (code === 127 || MISSING_H3.test(stderr)) throw new H3FatalError('h3 was not found on this machine', 502);
  return { code, stdout, lines, stderr };
}

function classifyFailure(prefix: string, detail: string, raw: string, fatal = false): AssetError {
  const said = detail || tail(raw) || 'no reason given';
  if (AUTH_FAILURE.test(raw) || AUTH_FAILURE.test(said)) {
    return new H3FatalError(`h3 is not authorized with Google Colab: ${said}`, 502);
  }
  const MessageError = fatal || NO_SESSION.test(raw) || NO_SESSION.test(said) ? H3FatalError : AssetError;
  return new MessageError(`${prefix}: ${said}`, 502);
}

/** Checks whether the default h3 Colab VM is already running before starting a batch. */
export async function status(options: H3Options = {}, signal?: AbortSignal): Promise<{ running: boolean }> {
  const out = await runH3(['status'], options.statusTimeoutMs ?? H3_STATUS_TIMEOUT_MS, 'h3 took too long to answer', options, signal);
  if (out.code === 0) return { running: true };
  const combined = `${out.stdout}\n${out.stderr}`;
  if (!AUTH_FAILURE.test(combined) && NO_SESSION.test(combined)) return { running: false };
  throw classifyFailure('h3 status failed', '', combined, true);
}

/** Boots the Colab VM and starts ComfyUI (`h3 up`). */
export async function up(options: H3Options = {}, signal?: AbortSignal): Promise<void> {
  const out = await runH3(['up'], options.bootTimeoutMs ?? H3_BOOT_TIMEOUT_MS, 'h3 took too long to start the VM', options, signal);
  if (out.code !== 0) throw classifyFailure('h3 could not start the VM', '', `${out.stderr}\n${out.stdout}`, true);
}

/** Redraws one picture from its reference image at 16 MP (`h3 edit --mp 16 -o <outDir> --json`). */
export async function draw(request: H3DrawRequest, options: H3Options = {}, signal?: AbortSignal): Promise<H3Picture> {
  const args = ['edit', '--mp', '16', '-o', request.outDir, '--json', '--', h3Prompt(request.prompt), request.reference];
  const out = await runH3(args, options.drawTimeoutMs ?? H3_DRAW_TIMEOUT_MS, 'h3 took too long to generate this picture', options, signal);
  let imagePath: string | undefined, failure: string | undefined, fatal = false;
  for (const line of out.lines) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.event === 'image' && event.ok === true && typeof event.path === 'string') imagePath = event.path;
    if (event.event === 'image' && event.ok === false && typeof event.error === 'string') failure = event.error;
    if (event.event === 'error' && typeof event.error === 'string') {
      failure = event.error;
      if (NO_SESSION.test(event.error) || AUTH_FAILURE.test(event.error)) fatal = true;
    }
  }
  if (!imagePath) {
    throw classifyFailure('h3 made no picture', failure ? tail(failure) : '', `${out.stderr}\n${out.stdout}`, fatal);
  }
  const file = resolve(request.outDir, imagePath);
  const data = await readFile(file).catch(() => {
    throw new AssetError('h3 made no picture: output file is missing', 502);
  });
  const type = rasterType(data);
  if (type !== 'png' && type !== 'jpeg' && type !== 'webp') {
    throw new AssetError('h3 answered with something other than a PNG, JPEG or WebP picture', 502);
  }
  return { file, data, mediaType: `image/${type}`, ...imageSize(data) };
}

/** Shuts down the Colab VM (`h3 down`). */
export async function down(options: H3Options = {}): Promise<void> {
  const out = await runH3(['down'], options.downTimeoutMs ?? H3_DOWN_TIMEOUT_MS, 'h3 down took too long; run h3 down in a terminal to stop billing', options);
  if (out.code !== 0) {
    const said = tail(`${out.stderr}\n${out.stdout}`) || `exit ${out.code}`;
    throw new AssetError(`h3 down failed; run h3 down yourself: ${said}`, 502);
  }
}
