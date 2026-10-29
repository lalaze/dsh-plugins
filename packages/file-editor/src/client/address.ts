import { languageOf } from '@dsh-plugins/file-view/kinds';

/** Conversations whose files live on another machine; Remote Agents opens those. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;
export interface FileAddress { sessionId: string; path: string; line?: number }

/** DSH's `dsh-resource://file/session/<id>/<path>` address, with an optional `#L42` line. */
export function fileAddress(address: string): FileAddress | undefined {
  try {
    const url = new URL(address), [scope, id, ...parts] = url.pathname.replace(/^\//, '').split('/');
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file' || scope !== 'session' || !id || !parts.length) return;
    const path = parts.map(decodeURIComponent).join('/'), line = /^#L(\d+)/.exec(url.hash)?.[1];
    return path ? { sessionId: decodeURIComponent(id), path, ...(line ? { line: Number(line) } : {}) } : undefined;
  } catch { return; }
}
/** Text and code files of local conversations; DSH keeps previewing images, documents and everything else. */
export function claims(address: string, cwdOf: (sessionId: string) => string | undefined): boolean {
  const parsed = fileAddress(address), cwd = parsed && cwdOf(parsed.sessionId);
  return !!parsed && !!cwd && !REMOTE_ANCHOR.test(cwd) && languageOf(parsed.path) !== undefined;
}
