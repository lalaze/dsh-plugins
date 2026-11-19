import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
/** DSH's dark theme base background (`--dsw-alias-bg-base` in dark mode, the boot-theme dark canvas). */
export const DEFAULT_DARK_COLOR = '#151517';
export const DISPLAY_MODES = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
/** Trim a configured color string and fall back to DSH's dark base color when empty. */
export function normalizeColor(value, fallback = DEFAULT_DARK_COLOR) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || fallback;
}
/**
 * Overlay PWA colors (and optional display mode) onto DSH's upstream manifest while preserving
 * all other fields such as `name`, `short_name`, `start_url`, `scope`, `id`, and `icons`.
 */
export function patchManifest(base, options = {}) {
    const next = { ...base };
    next.theme_color = normalizeColor(options.themeColor);
    next.background_color = normalizeColor(options.backgroundColor);
    if (options.display)
        next.display = options.display;
    return next;
}
function distIndexOf(config) {
    if (!config || typeof config !== 'object')
        return undefined;
    const distIndex = config.distIndex;
    return typeof distIndex === 'string' && distIndex.trim() ? distIndex.trim() : undefined;
}
/**
 * Locate the running DSH instance's own `manifest.webmanifest`.
 * Checks an explicit override first, then DSH's `frontend-static` fiber config (`distIndex`),
 * and finally tries resolving `@deepseek-ai/dsh-web-frontend/package.json` from the DSH entrypoint.
 */
export function discoverManifestPath(registry, explicitPath = '', entryPath = process.argv[1]) {
    const configured = explicitPath.trim();
    if (configured)
        return configured;
    if (registry) {
        try {
            for (const runtime of registry.values()) {
                if (runtime?.name !== 'frontend-static' || !runtime.fibers)
                    continue;
                for (const fiber of runtime.fibers) {
                    const distIndex = distIndexOf(fiber?.config);
                    if (distIndex)
                        return join(dirname(distIndex), 'manifest.webmanifest');
                }
            }
        }
        catch {
            // Ignore registry layout differences in future host versions.
        }
    }
    if (entryPath) {
        try {
            const require = createRequire(resolve(entryPath));
            const pkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json');
            return join(dirname(pkg), 'dist', 'manifest.webmanifest');
        }
        catch {
            // Running outside the DSH CLI entrypoint (e.g. unit tests or isolated plugin runner).
        }
    }
    return undefined;
}
/** Serialize a patched manifest and derive a stable strong ETag from its bytes. */
export function renderManifest(base, options = {}) {
    const body = Buffer.from(`${JSON.stringify(patchManifest(base, options), null, 2)}\n`, 'utf8');
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    return { body, etag: `"${hash}"` };
}
/** RFC 9110 §13.1.2 weak ETag comparison for `If-None-Match`. */
export function etagMatches(header, etag) {
    if (!header)
        return false;
    const raw = Array.isArray(header) ? header.join(',') : header;
    const target = stripWeak(etag.trim());
    for (const part of raw.split(',')) {
        const candidate = part.trim();
        if (!candidate)
            continue;
        if (candidate === '*')
            return true;
        if (stripWeak(candidate) === target)
            return true;
    }
    return false;
}
function stripWeak(tag) {
    return tag.startsWith('W/') ? tag.slice(2).trim() : tag;
}
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Reads DSH's own manifest and patches it, re-reading whenever the file's mtime or size changes.
 * There is no built-in manifest: until the upstream file has been read once, `load()` returns
 * `undefined` (the plugin then leaves `/manifest.webmanifest` to DSH). After that, a file that
 * disappears or stops parsing keeps the last good copy instead of changing the installed app.
 * The file is a few hundred bytes and fetched rarely, so it is read synchronously.
 */
export class ManifestLoader {
    resolvePath;
    options;
    warn;
    cached;
    lastWarning = '';
    constructor(resolvePath, options, warn = () => { }) {
        this.resolvePath = resolvePath;
        this.options = options;
        this.warn = warn;
    }
    load() {
        const path = this.resolvePath();
        if (!path)
            return this.keep('dsh-pwa: DSH\'s manifest.webmanifest could not be located');
        try {
            const info = statSync(path);
            if (this.cached && this.cached.path === path && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size) {
                return this.cached.rendered;
            }
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (!isPlainRecord(parsed))
                return this.keep(`dsh-pwa: ${path} is not a JSON object`);
            const rendered = renderManifest(parsed, this.options);
            this.cached = { path, mtimeMs: info.mtimeMs, size: info.size, rendered };
            this.lastWarning = '';
            return rendered;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return this.keep(`dsh-pwa: could not read ${path} (${detail})`);
        }
    }
    /** Answer a failed read with the last good copy, warning once per distinct problem. */
    keep(problem) {
        const rendered = this.cached?.rendered;
        const message = rendered ? `${problem}; keeping the last good manifest` : `${problem}; DSH keeps serving its own manifest`;
        if (this.lastWarning !== message) {
            this.lastWarning = message;
            this.warn(message);
        }
        return rendered;
    }
}
