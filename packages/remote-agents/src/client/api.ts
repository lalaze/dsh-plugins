/** The code editor bundle the plugin serves; see workspace/editor-route.ts. */
export const EDITOR_SRC = '/api/remote-agents/editor.js';
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** randomUUID is restricted to secure contexts; LAN HTTP previews still have getRandomValues. */
export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function api<T>(action?: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/remote-agents', action ? {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action, ...data }),
  } : { credentials: 'same-origin', cache: 'no-store', signal });
  const result = await response.json();
  if (!response.ok) throw new ApiError(typeof result.error === 'string' ? result.error : `Remote task request failed (${response.status})`, response.status);
  if (['addHost', 'removeHost', 'discoverHost', 'setHostProviders'].includes(action ?? '') && typeof window !== 'undefined') window.dispatchEvent(new Event('remote-agents-updated'));
  return result as T;
}
