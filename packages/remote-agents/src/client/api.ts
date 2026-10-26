export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
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
