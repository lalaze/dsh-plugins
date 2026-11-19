/**
 * dsh-pwa: serve DSH's own Web App manifest (`/manifest.webmanifest`) with dark `theme_color`
 * and `background_color`, so installed mobile PWAs (Android WebAPKs) draw a dark bottom system
 * navigation bar and keyboard bar instead of the white DSH declares. Nothing else changes: the
 * page, its styles and `<meta name="theme-color">` stay DSH's.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { ManifestLoader, type DisplayMode } from './manifest.js';
export declare const name = "dsh-pwa";
export interface Config {
    themeColor: string;
    backgroundColor: string;
    display: '' | DisplayMode;
    manifestPath: string;
}
export declare const Config: Schema<Config>;
/**
 * Resource for `/manifest.webmanifest` (public, like the rest of DSH's static files: browsers
 * fetch manifests without cookies). Only registered once `loader` has read DSH's file, so
 * `load()` always has at least the last good copy.
 */
export declare function createManifestResource(loader: ManifestLoader): (request: Request) => Promise<Response>;
export declare function apply(ctx: Context, config?: Partial<Config>): void;
export { DEFAULT_DARK_COLOR, discoverManifestPath, etagMatches, ManifestLoader, normalizeColor, patchManifest, renderManifest } from './manifest.js';
