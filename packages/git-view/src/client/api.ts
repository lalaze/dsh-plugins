import { CLIENT_HEADER } from '../domain.js';

/** The code editor bundle the plugin serves; see editor-route.ts. */
export const EDITOR_SRC = '/api/git-view/editor.js';
export class GitRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly auth?: 'https' | 'ssh') { super(message); }
}
/** randomUUID is restricted to secure contexts; DSH reached over plain HTTP still has getRandomValues. */
export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function git<T>(action: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/git-view', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new GitRequestError(typeof result.error === 'string' ? result.error : `Git request failed (${response.status})`, response.status, result.code, result.auth);
  return result as T;
}
