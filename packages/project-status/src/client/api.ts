import { CLIENT_HEADER, ROUTE, type Field, type StatusAnswer } from '../domain.js';

export class StatusRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function post<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { [CLIENT_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new StatusRequestError(typeof result.error === 'string' ? result.error : `Status request failed (${response.status})`, response.status);
  return result as T;
}
export const readStatus = (sessionId: string, signal?: AbortSignal) => post<StatusAnswer>({ action: 'get', sessionId }, signal);
/** @param was - the field's text when the edit began; the host refuses with 409 when the file has another by now. */
export const saveField = (sessionId: string, field: Field, value: string, was: string, language: 'zh' | 'en') => post<StatusAnswer>({ action: 'save', sessionId, field, value, was, language });
