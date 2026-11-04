import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stage } from '../agents/attachments.js';
import { attachmentInput, RemoteError } from '../core/domain.js';

/** Below the 255 bytes file systems allow; the same limit as a chat attachment's name. */
const MAX_NAME_BYTES = 160;
const EXTENSION = /\.[\p{L}\p{N}]{1,16}$/u;

/**
 * A file's name on the remote machine: recognizable, with nothing a shell or Claude Code's path detection must be careful
 * about. That includes the narrow space in a macOS screenshot's name, which spaces alone would miss.
 * @param value - the name the browser gave, which nothing vouches for.
 */
export function tuiFileName(value: unknown): string {
  const name = (typeof value === 'string' ? value : '').normalize('NFC').split(/[\\/]/).at(-1) ?? '';
  const extension = EXTENSION.exec(name)?.[0] ?? '';
  const cleaned = name.slice(0, name.length - extension.length).replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  let stem = '';
  for (const char of cleaned) {
    if (Buffer.byteLength(stem + char + extension) > MAX_NAME_BYTES) break;
    stem += char;
  }
  return `${stem || 'file'}${extension}`;
}
/** Where a file goes, relative to the project. The same file given twice has one copy, and two files never collide. */
export const tuiFilePath = (sha256: string, name: string) => `.dsh-remote-agents/attachments/tui/${sha256.slice(0, 16)}/${name}`;

/**
 * Files given to a TUI conversation's Claude Code, which runs on another machine and can see none of this one's. They go
 * inside the project because Claude Code asks before reading outside it, and stay there, as a chat's attachments do.
 */
export class TuiFiles {
  constructor(private readonly dsh: {
    isTui(sessionId: string): boolean;
    /** A private directory on this machine. */
    directory: string;
    /** Saves a file on the conversation's machine and returns its absolute path. */
    attach(sessionId: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal: AbortSignal): Promise<string>;
  }) {}
  /**
   * The file is staged here first: that gives the digest the SSH upload checks, and a transfer the browser gives up on
   * never reaches the machine.
   * @returns the file's absolute path on the conversation's machine.
   */
  async upload(sessionId: string, name: unknown, input: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
    if (!this.dsh.isTui(sessionId)) throw new RemoteError('Files can only be added to a TUI conversation', 409);
    const directory = join(this.dsh.directory, 'tui-uploads', randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const { sha256, bytes, name: saved } = await stage(directory, input, (sha256, bytes) => attachmentInput([{ sha256, bytes, name: tuiFileName(name), kind: 'file' }])[0], signal);
      // Opened only once it is read, so a machine that turns out to be unreachable leaves no file open.
      const content = (async function* () { yield* createReadStream(join(directory, sha256)); })();
      return await this.dsh.attach(sessionId, tuiFilePath(sha256, saved), content, bytes, sha256, signal);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
