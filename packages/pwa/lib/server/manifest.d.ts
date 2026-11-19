import type { PluginRegistry } from './dsh.js';
/** DSH's dark theme base background (`--dsw-alias-bg-base` in dark mode, the boot-theme dark canvas). */
export declare const DEFAULT_DARK_COLOR = "#151517";
export declare const DISPLAY_MODES: readonly ["fullscreen", "standalone", "minimal-ui", "browser"];
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export interface ManifestOptions {
    readonly themeColor: string;
    readonly backgroundColor: string;
    readonly display: '' | DisplayMode;
}
/** Trim a configured color string and fall back to DSH's dark base color when empty. */
export declare function normalizeColor(value: string | undefined, fallback?: string): string;
/**
 * Overlay PWA colors (and optional display mode) onto DSH's upstream manifest while preserving
 * all other fields such as `name`, `short_name`, `start_url`, `scope`, `id`, and `icons`.
 */
export declare function patchManifest(base: Readonly<Record<string, unknown>>, options?: Partial<ManifestOptions>): Record<string, unknown>;
/**
 * Locate the running DSH instance's own `manifest.webmanifest`.
 * Checks an explicit override first, then DSH's `frontend-static` fiber config (`distIndex`),
 * and finally tries resolving `@deepseek-ai/dsh-web-frontend/package.json` from the DSH entrypoint.
 */
export declare function discoverManifestPath(registry: PluginRegistry | undefined, explicitPath?: string, entryPath?: string | undefined): string | undefined;
export interface RenderedManifest {
    readonly body: Buffer;
    readonly etag: string;
}
/** Serialize a patched manifest and derive a stable strong ETag from its bytes. */
export declare function renderManifest(base: Readonly<Record<string, unknown>>, options?: Partial<ManifestOptions>): RenderedManifest;
/** RFC 9110 §13.1.2 weak ETag comparison for `If-None-Match`. */
export declare function etagMatches(header: string | string[] | null | undefined, etag: string): boolean;
/**
 * Reads DSH's own manifest and patches it, re-reading whenever the file's mtime or size changes.
 * There is no built-in manifest: until the upstream file has been read once, `load()` returns
 * `undefined` (the plugin then leaves `/manifest.webmanifest` to DSH). After that, a file that
 * disappears or stops parsing keeps the last good copy instead of changing the installed app.
 * The file is a few hundred bytes and fetched rarely, so it is read synchronously.
 */
export declare class ManifestLoader {
    private readonly resolvePath;
    private readonly options;
    private readonly warn;
    private cached?;
    private lastWarning;
    constructor(resolvePath: () => string | undefined, options: Partial<ManifestOptions>, warn?: (message: string) => void);
    load(): RenderedManifest | undefined;
    /** Answer a failed read with the last good copy, warning once per distinct problem. */
    private keep;
}
