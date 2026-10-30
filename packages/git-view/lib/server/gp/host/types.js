/**
 * dsh-git-panel host wire data model — the authoritative type source.
 * The client half (src/client/rpc.ts) reuses these types directly, so the
 * wire contract has a single definition and cannot drift.
 */
/**
 * Diff context (-U) values shared by both halves. `DEFAULT` matches git's own
 * default and is what the host applies when a request omits `context`.
 * `MAX` is the host's clamp ceiling. `EXPAND` is what the "expand all" button
 * asks for: deliberately bounded, because a -U window wide enough to cover a
 * huge file makes the host emit that whole file as one hunk — megabytes of
 * text, and past the runner's stdout cap a silently truncated diff. Whatever
 * the window does not reach stays a collapsed gap the view reveals on demand.
 */
export const DIFF_CONTEXT_DEFAULT = 3;
export const DIFF_CONTEXT_MAX = 100000;
export const DIFF_EXPAND_CONTEXT = 2000;
/**
 * Ceiling for the working-file read taken only to count the diff's new-side
 * lines. That count decides whether hidden context follows the last hunk, so it
 * is read on every diff query — including the changes tab's poll while a diff is
 * open — while `file-lines` (the on-demand expansion) stays uncapped. Above this
 * size the count reports 0 (unknown) and no trailing control is offered.
 */
export const DIFF_COUNT_READ_MAX = 8 * 1024 * 1024;
/** Hard ceiling for a `fullChanges` snapshot (the client's "expand all"):
 * well above the default `maxChanges` (1000) so a big-but-sane change set
 * expands completely, while an absurd one stays bounded on the wire. */
export const FULL_CHANGES_MAX = 10_000;
// ── queries (read-only endpoint) ──────────────────────────────────────────
/**
 * True when a history `search` is a commit-hash prefix jump rather than a
 * message regex: 7–40 hex chars after trimming.
 */
export function isHistoryHashSearch(search) {
    return /^[0-9a-fA-F]{7,40}$/.test(search.trim());
}
/** Whether Git's effective content filters hide commits; hash jumps ignore them.
 * Shared with clients receiving history from a host that omits topology. */
export function isHistoryFiltered(query) {
    const search = query.search?.trim() ?? '';
    return !isHistoryHashSearch(search) && (search !== '' || (query.author ?? '') !== '' || (query.since ?? '') !== '');
}
/**
 * Byte envelope of the file browser's "copy file content" action: a text
 * document is copyable strictly below this size. Shared by both halves —
 * the host floors its text read here (so every copyable document can
 * actually load) and the client hides the copy button at/above it, keeping
 * one boundary for load and copy. An SVG is a copyable document too: the host
 * floors its read here and serves it as source once it passes the image cap.
 */
export const FILE_COPY_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Range of the profile's `maxBytes` — the per-command stdout cap, which also
 * caps each image-diff side and each image preview. Below the floor nearly every
 * command's output turns lossy (the runner marks it, so the views degrade to
 * empty), and above the ceiling one command could collect that much into the
 * host. Out-of-range values clamp into the range: a typo must not be able to
 * disable the panel or exhaust memory.
 */
export const MAX_BYTES_LIMITS = { min: 64 * 1024, max: 64 * 1024 * 1024, default: 4 * 1024 * 1024 };
// ── AI commit-message suggestion ─────────────────────────────────────────
/**
 * Suggest-limit ranges and defaults, in host storage units (bytes / tokens /
 * ms) — the single source shared by both plugin halves (the client bundle
 * imports this value, like imageMimeFor below): the host's DEFAULT_CONFIG and
 * normalizeConfig clamp every read into [min, max], and the detail-page form
 * derives its display units from it (the /1024 and /1000 divisions are exact
 * and guarded by test).
 */
export const SUGGEST_LIMITS = {
    maxBytes: { min: 16 * 1024, max: 512 * 1024, default: 200 * 1024 },
    maxOutputTokens: { min: 256, max: 16384, default: 4096 },
    timeoutMs: { min: 5000, max: 120000, default: 15000 },
};
/**
 * Selectable commit-message languages. `auto` infers the language from the
 * repository's own commit history (see resolveSuggestLanguage); `zh` / `en`
 * pin it. Shared by both halves like SUGGEST_LIMITS — the detail-page form
 * renders one segment per entry.
 */
export const SUGGEST_LANGUAGES = ['auto', 'zh', 'en'];
/** Default is `auto`: follow the style the repository is already written in. */
export const SUGGEST_LANGUAGE_DEFAULT = 'auto';
/** MIME of an SVG: the one served image whose bytes are also text. */
export const SVG_MIME = 'image/svg+xml';
/**
 * Extensions the image-diff query serves, mapped to MIME types. Part of the
 * query's contract, so both halves gate on this one list and cannot drift.
 */
export const IMAGE_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: SVG_MIME,
    ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
};
/** MIME for a path's extension; null when it is not a served image type. */
export function imageMimeFor(path) {
    const dot = path.lastIndexOf('.');
    if (dot < 0)
        return null;
    return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}
