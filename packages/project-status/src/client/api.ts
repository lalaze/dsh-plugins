import { CLIENT_HEADER, ROUTE, type Change, type StatusAnswer } from '../domain.js';

export class StatusRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function post<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new StatusRequestError(typeof result.error === 'string' ? result.error : `Status request failed (${response.status})`, response.status);
  return result as T;
}
export const readStatus = (sessionId: string, signal?: AbortSignal) => post<StatusAnswer>({ action: 'get', sessionId }, signal);
/** Makes one change to the status. The host refuses with 409 when the text it replaces is no longer what the change names. */
export const changeStatus = (sessionId: string, change: Change, language: 'zh' | 'en') => post<StatusAnswer>({ action: 'change', sessionId, change, language });
