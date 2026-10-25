export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
  /** Timeouts and server/transport failures leave delivery uncertain. */
  get rejected(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 408; }
}
export async function api<T>(action?: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/remote-agents', action ? {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action, ...data }),
  } : { credentials: 'same-origin', cache: 'no-store', signal });
  const result = await response.json();
  if (!response.ok) throw new ApiError(typeof result.error === 'string' ? result.error : `Remote task request failed (${response.status})`, response.status);
  return result as T;
}
export function readLocal<T>(key: string): T | undefined {
  try { return JSON.parse(localStorage.getItem(`dsh-remote-agents.${key}`) ?? 'null') ?? undefined; } catch { return; }
}
export function saveLocal(key: string, value: unknown): void {
  try { if (value === undefined) localStorage.removeItem(`dsh-remote-agents.${key}`); else localStorage.setItem(`dsh-remote-agents.${key}`, JSON.stringify(value)); } catch { /* Server task IDs remain durable when browser storage is unavailable. */ }
}
/** Tailscale HTTP previews are not secure contexts, so randomUUID is unavailable there. */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
