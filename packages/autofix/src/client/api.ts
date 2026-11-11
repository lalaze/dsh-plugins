import type { State } from '../service.js';

export type { State };
export type Reply<T = Record<string, unknown>> = T & { state?: State; error?: string; said?: { key: string; values?: Record<string, string>; detail?: string } };
/** One request to the plugin; a refusal is thrown with the server's words, and still carries the latest state. */
export async function call<T = Record<string, unknown>>(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply<T>> {
  const response = await fetch('/api/autofix', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json', 'X-DSH-Autofix': '1' }, body: JSON.stringify({ action, ...body }) });
  let reply: Reply<T>;
  try { reply = await response.json() as Reply<T>; }
  catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok) throw Object.assign(new Error(reply.error || `HTTP ${response.status}`), { state: reply.state, said: reply.said });
  return reply;
}
