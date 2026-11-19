import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_DARK_COLOR, discoverManifestPath, DISPLAY_MODES, etagMatches, ManifestLoader, } from './manifest.js';
export const name = 'dsh-pwa';
export const Config = Schema.object({
    themeColor: Schema.string()
        .default(DEFAULT_DARK_COLOR)
        .description('Web App manifest theme_color (Android <=14 bottom navigation / keyboard bar & app chrome) / 应用清单 theme_color（Android 14 及以前底部导航与键盘切换栏颜色）'),
    backgroundColor: Schema.string()
        .default(DEFAULT_DARK_COLOR)
        .description('Web App manifest background_color (Android 15+ bottom bar backdrop, keyboard transition & splash screen) / 应用清单 background_color（Android 15+ 底栏透出色、键盘切换底色与启动屏背景）'),
    display: Schema.union(['', ...DISPLAY_MODES])
        .default('')
        .description('Optional manifest display mode override; empty keeps DSH\'s own value / 可选覆盖清单 display 模式，留空沿用 DSH 原值'),
    manifestPath: Schema.string()
        .default('')
        .description('Optional explicit path to upstream manifest.webmanifest; empty auto-discovers DSH\'s file / 可选指定上游 manifest.webmanifest 路径，留空自动查找 DSH 原文件'),
});
const MANIFEST_ROUTE = '/manifest.webmanifest';
const MANIFEST_CONTENT_TYPE = 'application/manifest+json; charset=utf-8';
/**
 * Resource for `/manifest.webmanifest` (public, like the rest of DSH's static files: browsers
 * fetch manifests without cookies). Only registered once `loader` has read DSH's file, so
 * `load()` always has at least the last good copy.
 */
export function createManifestResource(loader) {
    return async (request) => {
        const rendered = loader.load();
        if (!rendered)
            return new Response(null, { status: 404 });
        const cache = { 'cache-control': 'no-cache', etag: rendered.etag };
        if (etagMatches(request.headers.get('if-none-match'), rendered.etag)) {
            return new Response(null, { status: 304, headers: cache });
        }
        return new Response(new Uint8Array(rendered.body), {
            status: 200,
            headers: { 'content-type': MANIFEST_CONTENT_TYPE, ...cache },
        });
    };
}
export function apply(ctx, config = {}) {
    const options = {
        themeColor: config.themeColor ?? DEFAULT_DARK_COLOR,
        backgroundColor: config.backgroundColor ?? DEFAULT_DARK_COLOR,
        display: config.display ?? '',
    };
    const explicitPath = config.manifestPath ?? '';
    ctx.inject(['webServer'], scoped => {
        const webServer = scoped.get('webServer');
        const logger = (scoped.get('logger') ?? ctx.get('logger'));
        const loader = new ManifestLoader(() => discoverManifestPath((scoped.registry ?? ctx.registry), explicitPath), options, message => logger?.warn?.(message));
        // Take over the route only once DSH's own manifest has been read: until then DSH keeps
        // answering with its file, rather than this plugin inventing one.
        const tryRegister = () => {
            if (!loader.load())
                return false;
            scoped.effect(() => webServer.register({ kind: 'exact', path: MANIFEST_ROUTE, resource: createManifestResource(loader) }), 'dsh-pwa: manifest route');
            return true;
        };
        if (tryRegister())
            return;
        // `frontend-static`, which knows where DSH's dist lives, may start after this scope.
        const stop = scoped.on('internal/status', () => {
            try {
                if (tryRegister())
                    stop();
            }
            catch (error) {
                stop();
                logger?.warn?.(`dsh-pwa: could not take over ${MANIFEST_ROUTE}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });
}
export { DEFAULT_DARK_COLOR, discoverManifestPath, etagMatches, ManifestLoader, normalizeColor, patchManifest, renderManifest } from './manifest.js';
