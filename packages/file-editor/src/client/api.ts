/** What reading a file returns; only text has its contents. */
export interface FileState { path: string; size: number; mtimeMs: number }
export type FileRead = FileState & ({ kind: 'text'; content: string; revision: string } | { kind: 'binary'; revision: string } | { kind: 'large' });
export type Saved = FileState & { revision: string };

const HEADER = { 'X-DSH-File-Editor': '1' };
/** The code editor bundle the plugin serves; see editor-route.ts. */
export const EDITOR_SRC = '/api/file-editor/editor.js';
export async function fileRequest<T>(action: 'read' | 'stat' | 'write', data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/file-editor', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { ...HEADER, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : `File request failed (${response.status})`), { status: response.status });
  return result as T;
}
