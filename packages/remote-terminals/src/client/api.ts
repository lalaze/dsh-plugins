export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** One request to the plugin; see createHandler in the server's index.ts. */
export async function api<T>(action: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/remote-terminals', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action, ...data }),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(typeof result.error === 'string' ? result.error : `Remote terminals request failed (${response.status})`, response.status);
  return result as T;
}
