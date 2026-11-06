/** Requests to this plugin's own route. */
import { API_PATH } from '../shared.js';
import { ui } from './i18n.js';

export async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(API_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-DSH-Model-Flow': '1' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : ui('Could not save.'));
  return result as T;
}
