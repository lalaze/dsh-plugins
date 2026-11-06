/** Used on both sides, so it must not import anything from Node. */
export const API_PATH = '/api/model-flow';
export interface EffortOption { id: string; label: string }
export type Locale = 'en' | 'zh';

/** What the client asks about a running row. Text is ready to show, in the language of the goal. */
export interface LiveStep { title: string; elapsed: string; activity: string; parentId: string; childId?: string }

/** Rows are saved as text: a title, then the full result, then what the row needs to know that is not for reading. */
export interface RowParts { title: string; body?: string; parentId?: string; childId?: string; open?: boolean }
const META = /\n*<!-- flow-row (\{.*\}) -->\s*$/u;
const MAX_BODY = 40000;
export function rowText({ title, body, parentId, childId, open }: RowParts): string {
  const trimmed = body?.trim(), kept = trimmed && trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}…` : trimmed;
  const meta = { ...(parentId && childId ? { parentId, childId } : {}), ...(open ? { open } : {}) };
  return `${title}${kept ? `\n\n${kept}` : ''}${Object.keys(meta).length ? `\n\n<!-- flow-row ${JSON.stringify(meta)} -->` : ''}`;
}
export function parseRow(text: string): RowParts {
  const match = META.exec(text), rest = match ? text.slice(0, match.index) : text, end = rest.indexOf('\n');
  const body = end < 0 ? '' : rest.slice(end + 1).trim();
  let meta: Pick<RowParts, 'parentId' | 'childId' | 'open'> = {};
  try { if (match) meta = JSON.parse(match[1]) as typeof meta; } catch { /* Text a model wrote can look like this; it is then just text. */ }
  return { title: (end < 0 ? rest : rest.slice(0, end)).trim(), ...(body ? { body } : {}), ...meta };
}
