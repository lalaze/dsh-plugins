/** Used on both sides, so it must not import anything from Node. */
export const API_PATH = '/api/model-flow';
const META = /\n*<!-- flow-row (\{.*\}) -->\s*$/u;
const MAX_BODY = 40000;
export function rowText({ title, body, parentId, childId, open }) {
    const trimmed = body?.trim(), kept = trimmed && trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}…` : trimmed;
    const meta = { ...(parentId && childId ? { parentId, childId } : {}), ...(open ? { open } : {}) };
    return `${title}${kept ? `\n\n${kept}` : ''}${Object.keys(meta).length ? `\n\n<!-- flow-row ${JSON.stringify(meta)} -->` : ''}`;
}
export function parseRow(text) {
    const match = META.exec(text), rest = match ? text.slice(0, match.index) : text, end = rest.indexOf('\n');
    const body = end < 0 ? '' : rest.slice(end + 1).trim();
    let meta = {};
    try {
        if (match)
            meta = JSON.parse(match[1]);
    }
    catch { /* Text a model wrote can look like this; it is then just text. */ }
    return { title: (end < 0 ? rest : rest.slice(0, end)).trim(), ...(body ? { body } : {}), ...meta };
}
