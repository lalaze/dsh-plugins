import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** Remote images larger than this stay as alt text: each one is copied over SSH while the reply streams. */
export const CHAT_IMAGE_LIMIT = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s()<>]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** An unfinished image can be held back this long before it is shown as written. */
const HOLD_LIMIT = 2048;

/** A workspace path from a Markdown image destination, or undefined for URLs, anchors and non-image files. */
export function imagePathOf(destination: string): string | undefined {
  let path = destination.startsWith('<') ? destination.slice(1, -1) : destination;
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('#')) return;
  path = path.split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { return; }
  return EXTENSIONS.has(extname(path).toLowerCase()) ? path : undefined;
}

/** Save a remote image under `directory` by content hash; the same bytes reuse one file. */
export async function saveChatImage(directory: string, path: string, data: Uint8Array): Promise<string> {
  const file = join(directory, `${createHash('sha256').update(data).digest('hex')}${extname(path).toLowerCase()}`);
  if (await stat(file).then(s => s.isFile(), () => false)) return file;
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return file;
}

/**
 * Rewrites Markdown images that name remote workspace files so they point at local copies. The DSH chat
 * reads image paths on the DSH host, where a remote workspace's files do not exist. Text arrives in
 * deltas, so an image that is still incomplete is held back until it closes.
 */
export class ChatImageLinks {
  private pending = '';
  private readonly resolved = new Map<string, Promise<string | undefined>>();
  /** `resolve` returns a local absolute path for a remote workspace path, or undefined to leave it as written. */
  constructor(private readonly resolve: (path: string) => Promise<string | undefined>) {}
  /** Add streamed text; returns the text that is ready to show. */
  async push(text: string): Promise<string> {
    const buffer = this.pending + text;
    let output = '', last = 0;
    for (const match of buffer.matchAll(IMAGE)) {
      output += buffer.slice(last, match.index) + await this.rewrite(match);
      last = match.index + match[0].length;
    }
    const rest = buffer.slice(last), hold = this.holdFrom(rest);
    this.pending = rest.slice(hold);
    return output + rest.slice(0, hold);
  }
  /** Release held text as written, when the text block ends. */
  flush(): string {
    const text = this.pending; this.pending = '';
    return text;
  }
  /** Where an image that may still be completing begins in `text`. */
  private holdFrom(text: string): number {
    if (text.endsWith('!')) return text.length - 1;
    const start = text.lastIndexOf('![');
    return start >= 0 && !text.includes('\n', start) && text.length - start <= HOLD_LIMIT ? start : text.length;
  }
  private async rewrite(match: RegExpMatchArray): Promise<string> {
    const path = imagePathOf(match[2]);
    if (path === undefined) return match[0];
    let local = this.resolved.get(path);
    if (!local) { local = this.resolve(path).catch(() => undefined); this.resolved.set(path, local); }
    const file = await local;
    return file && !/[<>\n]/.test(file) ? `![${match[1]}](<${file.replace(/\\/g, '/')}>${match[3] ?? ''})` : match[0];
  }
}
