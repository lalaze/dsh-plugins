import { CLIENT_HEADER, ROUTE, type Fields, type StatusAnswer } from '../domain.js';

export class StatusRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function post<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new StatusRequestError(typeof result.error === 'string' ? result.error : `Status request failed (${response.status})`, response.status);
  return result as T;
}
export const readStatus = (sessionId: string, signal?: AbortSignal) => post<StatusAnswer>({ action: 'get', sessionId }, signal);
/** @param revision - the one the edit started from; the host refuses with 409 when the file has another by now. */
export const saveStatus = (sessionId: string, fields: Fields, revision: string, language: 'zh' | 'en') => post<StatusAnswer>({ action: 'save', sessionId, fields, revision, language });
