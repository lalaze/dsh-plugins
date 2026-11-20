/**
 * The DSH 0.2.2 internals a mounted machine's page depends on, all in this file. Each rewrite checks the markup it
 * relies on and leaves the page as DSH served it when that is gone, returning what it found so the host can log it.
 * The desktop guard follows Kivotos (github.com/dsh-labs/kivotos, Apache-2.0), see THIRD_PARTY_NOTICES.md.
 *
 * No Node imports: the client bundle uses some of these names.
 */
/** Where machines are mounted on this host's webServer. */
export const MOUNT_ROOT = '/dsh-link/peer';
export const mountPrefix = (id) => `${MOUNT_ROOT}/${id}`;
/** A page under a mount: its machine id. */
export function mountedId(pathname) {
    return /^\/dsh-link\/peer\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathname)?.[1];
}
/** dsh-client-store keeps the current Session here (`{ sessionId }`), restored once at boot. */
export const CURRENT_SESSION_KEY = 'dsh.sessions.current';
/** The localStorage prefix of one machine's page. */
export const storagePrefix = (id) => `dsh-link:${id}:`;
/** A script as early as possible in the head, before any of DSH's own. */
export function injectHead(html, script) {
    const at = /<head[^>]*>/i.exec(html);
    if (!at)
        return script + html;
    const end = at.index + at[0].length;
    return html.slice(0, end) + script + html.slice(end);
}
/** JSON for a script body that cannot close the script element. */
const literal = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
const TRANSPORT = '__DSH_TRANSPORT__';
/**
 * Pages served through this plugin belong to the same tailnet user, so they get the operator surface a loopback page
 * gets (`isLoopback` in dsh-client-connection reads `ownsHost`).
 */
export function injectOwnsHost(html) {
    return injectHead(html, `<script>globalThis.${TRANSPORT}=Object.assign(globalThis.${TRANSPORT}||{},{ownsHost:true})</script>`);
}
const MANIFEST_FROM = '<link rel="manifest" href="./manifest.webmanifest" />';
const MANIFEST_TO = '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />';
/** Browsers fetch a manifest without cookies, and every path under a mount is behind the fence. */
export function credentialedManifest(html) {
    if (html.includes(MANIFEST_FROM))
        return { html: html.replace(MANIFEST_FROM, MANIFEST_TO), misses: [] };
    return { html, misses: /rel=["']?manifest/i.test(html) ? [{ point: 'manifest', reason: 'the manifest link is not the 0.2.2 form' }] : [] };
}
const BOOT_GATE = '__DSH_BOOT_READY__';
const BOOT_GATE_TAIL = `<script>(globalThis.${BOOT_GATE} ??= Promise.withResolvers()).resolve()</script>`;
const DESKTOP_BRIDGE = 'dshDesktopBoot';
/**
 * Keep the desktop app's own boot out of a mounted page. The desktop shell exposes `dshDesktopBoot` to every page of
 * `dsh-app://app`; DSH's web entry would apply this computer's boot rows and stream URL on top of the machine's own.
 * The guard takes the handshake itself, rebases the stream URL under the mount, holds the boot gate until then and
 * refuses the entry's own transport. Outside the desktop window (a browser, the phone) it does nothing.
 *
 * A machine's page kept in a frame of the desktop window (see client/shell.ts) has no bridge of its own: the shell
 * already booted, so the guard takes the stream URL the window's page got and rebases it the same way.
 */
export function guardDesktopBoot(html, prefix) {
    const script = `<script>(()=>{const d=globalThis.${DESKTOP_BRIDGE},own=typeof d==="object"&&d!==null&&typeof d.ready==="function";let w;if(!own){try{const p=globalThis.parent;if(p!==globalThis&&typeof p.${DESKTOP_BRIDGE}==="object"&&p.${DESKTOP_BRIDGE}!==null)w=p.${TRANSPORT}?.streamBaseUrl}catch{}if(typeof w!=="string")return}const m=${literal(`${prefix}/`)},b=Promise.withResolvers();let t=globalThis.${TRANSPORT};Object.defineProperty(globalThis,"${TRANSPORT}",{configurable:true,enumerable:true,get:()=>t,set(n){if(n!==t&&typeof n==="object"&&n!==null&&"streamBaseUrl" in n)throw new Error("dsh-link: a machine's page keeps its own boot");t=n}});globalThis.${BOOT_GATE}={promise:b.promise,resolve(){},reject(){}};const go=u=>{t={...t,ownsHost:true,streamBaseUrl:new URL(m,u).href};b.resolve()};if(own)d.ready().then(r=>go(r.streamBaseUrl),b.reject);else go(w)})()</script>`;
    const misses = html.includes(BOOT_GATE_TAIL) ? [] : [{ point: 'desktop-boot', reason: html.includes(BOOT_GATE) ? `${BOOT_GATE} is not settled by the 0.2.2 tail script` : `the page has no ${BOOT_GATE}` }];
    return { html: injectHead(html, script), misses };
}
/** The window's own page keeps the machines it shows in frames (client/shell.ts); these keys are shared with it. */
export const SHELL_KEYS = { keepPages: 'dsh-link:keep-pages', shown: 'dsh-link:shown', direct: 'dsh-link:direct', returned: 'dsh-link:returned' };
/**
 * A machine's page opened as the window's page (by its address, a bookmark, a reload of a page an older version
 * opened) goes to this computer's own page, which shows the machine in a frame: otherwise switching away from it loads
 * a whole page every time. Not when keeping pages is off (by choice, or by default over HTTP/1.1: see client/shell.ts),
 * nor for the machine the user chose to open directly.
 */
export function injectShellReturn(html, id) {
    const script = `<script>(()=>{try{if(window.top!==window)return;const s=window.sessionStorage,l=window.localStorage,id=${literal(id)};const k=l.getItem(${literal(SHELL_KEYS.keepPages)}),n=performance.getEntriesByType("navigation")[0];if(k==="off"||(k!=="on"&&n&&n.nextHopProtocol==="http/1.1")||s.getItem(${literal(SHELL_KEYS.direct)})===id)return;s.setItem(${literal(SHELL_KEYS.shown)},id);s.setItem(${literal(SHELL_KEYS.returned)},id);location.replace("/")}catch{}})()</script>`;
    return injectHead(html, script);
}
/** The global a window's own page keeps its shell on (client/shell.ts). */
export const SHELL_GLOBAL = '__dshLinkShell';
/** What the desktop window's DSH Link lends a machine's page in one of its frames: its browser (frame/browser.ts). */
export const DESKTOP_GLOBAL = '__dshLinkDesktop';
/** The settings the frame browser script reads: `{ machine, port }`. */
export const FRAME_CONFIG_GLOBAL = '__dshLinkFrame';
/** On the shell page's root: the height of the title strip over its frames in a desktop window (client/styles.ts). */
export const BAR_HEIGHT = '--dl-bar-height';
/**
 * A machine's page in a frame of the desktop window fills the whole window, so its background (and a wallpaper) reaches
 * the top as on the window's own page. The shell's see-through title strip lies over the top band: the page starts
 * below it, and its menus and dialogs keep clear of it. The band follows the window (none in full screen).
 *
 * The left sidebar still reaches the top, as on the window's own page, where it runs under the window buttons: DSH's
 * frame is pulled back up over the band with its columns starting below it, the sidebar column alone climbs back into
 * it, and the sidebar's content keeps clear of it by a see-through top border, which its own fill (or a wallpaper tint)
 * paints under. The frame's overlay layer and its leading controls (the drawer's opener) stay below the band.
 */
export function injectFrameTop(html) {
    const top = 'var(--dl-top,0px)';
    const frame = `html[data-dl-framed] #root div:has(>[data-shell-overlay])`;
    const style = `<style>html[data-dl-framed] body{box-sizing:border-box;padding-top:${top}}html[data-dl-framed]{--dsh-frame-overlay-top:calc(${top} + 12px)}`
        + `${frame}{margin-top:calc(0px - ${top});height:calc(100% + ${top});padding-top:${top}}`
        + `${frame}:not([data-sidebar-drawer])>:has(>[data-slot="sidebar"]){margin-top:calc(0px - ${top})}`
        + `${frame}>*>[data-slot="sidebar"]>*{border-top:${top} solid transparent}`
        + `${frame}>[data-shell-overlay]{top:${top}}${frame}>[data-shell-leading]{margin-top:${top}}`
        // dsh-browser-devtools' debugger window would open on the machine, not in front of the user.
        + `html[data-dl-framed] [data-dsh-browser-devtools="detach"]{display:none!important}</style>`;
    const script = `<script>(()=>{try{const p=window.parent;if(p===window||!p.${SHELL_GLOBAL})return;const h=document.documentElement,r=p.document.documentElement,set=()=>{try{const v=p.getComputedStyle(r).getPropertyValue(${literal(BAR_HEIGHT)}).trim();if(v&&parseFloat(v)>0)h.style.setProperty("--dl-top",v);else h.style.removeProperty("--dl-top")}catch{}};h.setAttribute("data-dl-framed","");set();new MutationObserver(set).observe(r,{attributes:true})}catch{}})()</script>`;
    return injectHead(html, style + script);
}
/** Where the namespace script leaves the page's real localStorage, for the switcher to pick another machine's Session. */
export const RAW_STORAGE = '__dshLinkStorage';
/**
 * Give a mounted page its own localStorage. Every machine's page is served from this host's origin and DSH keeps its
 * stores under fixed keys, so without this two machines' pages would overwrite each other's state.
 */
export function injectStorageNamespace(html, id) {
    const script = `<script>(()=>{const s=window.localStorage,p=${literal(storagePrefix(id))},own=()=>{const k=[];for(let i=0;i<s.length;i++){const n=s.key(i);if(n!==null&&n.startsWith(p))k.push(n.slice(p.length))}return k};const v={getItem:k=>s.getItem(p+k),setItem:(k,x)=>s.setItem(p+k,String(x)),removeItem:k=>s.removeItem(p+k),key:i=>own()[i]??null,clear:()=>{for(const k of own())s.removeItem(p+k)},get length(){return own().length}};Object.defineProperty(window,${literal(RAW_STORAGE)},{configurable:true,value:s});Object.defineProperty(window,"localStorage",{configurable:true,get:()=>v})})()</script>`;
    return injectHead(html, script);
}
/**
 * Send a mounted page's requests by absolute path to its machine. DSH's own requests are relative to the page or go
 * through the rebased stream, but plugins call their routes by absolute path (`fetch('/api/remote-agents')`), which on
 * this host's origin reaches this computer's DSH: the Mac mini's model picker asked the MacBook's remote-agents which
 * machines fit a Mac mini conversation, got none and hid every remote CLI. Same-origin paths outside `/dsh-link/` (this
 * host's switcher and attention routes, and the mounts) get the mount prefix in fetch, XMLHttpRequest, EventSource and
 * sendBeacon. Element URLs, `import()` and WebSocket are left alone: the only upgrade a mount forwards is DSH's stream.
 */
export function injectRequestBase(html, prefix) {
    const script = `<script>(()=>{const m=${literal(prefix)},g=globalThis,l=g.location,to=u=>{let x;try{x=new URL(String(u),l.href)}catch{return u}if(x.protocol!==l.protocol||x.host!==l.host||x.pathname==="/dsh-link"||x.pathname.startsWith("/dsh-link/"))return u;x.pathname=m+x.pathname;return x.href};const f=g.fetch;if(typeof f==="function")g.fetch=function(i,n){if(typeof Request==="function"&&i instanceof Request){const t=to(i.url);if(t!==i.url)try{i=new Request(t,i)}catch{}}else if(typeof i==="string"||i instanceof URL)i=to(i);return f.call(this,i,n)};const X=g.XMLHttpRequest;if(typeof X==="function"){const o=X.prototype.open;X.prototype.open=function(a,u,...r){return o.call(this,a,to(u),...r)}}const E=g.EventSource;if(typeof E==="function")g.EventSource=class extends E{constructor(u,c){super(to(u),c)}};const n=g.navigator;if(n&&typeof n.sendBeacon==="function"){const b=n.sendBeacon;n.sendBeacon=function(u,d){return b.call(this,to(u),d)}}})()</script>`;
    return injectHead(html, script);
}
/** The page's real localStorage: the namespace script's copy on a mounted page, else the page's own. */
export function rawStorage() {
    return globalThis[RAW_STORAGE] ?? globalThis.localStorage;
}
/** Make a Session the one a machine's page restores at its next boot ('' as id: this host's own page). */
export function selectSession(storage, machineId, sessionId) {
    storage.setItem(`${machineId ? storagePrefix(machineId) : ''}${CURRENT_SESSION_KEY}`, JSON.stringify({ sessionId }));
}
/**
 * Lend a machine's page in a frame of the desktop window the window's browser (frame/browser.ts). The script does
 * nothing anywhere else.
 */
export function injectFrameBrowser(html, id, browser) {
    const config = `<script>globalThis.${FRAME_CONFIG_GLOBAL}=${literal({ machine: id, port: browser.port })}</script>`;
    return injectHead(html, `${config}<script>${browser.script.replaceAll('</script', '<\\/script')}</script>`);
}
/**
 * A machine's index as this host serves it under its mount. Scripts run in head order, so the request base and the
 * namespace come first (everything after them requests from the machine and reads the namespaced storage), then the
 * desktop guard.
 */
export function mountedIndex(html, id, browser) {
    const manifest = credentialedManifest(html);
    const guarded = guardDesktopBoot(manifest.html, mountPrefix(id));
    const page = injectFrameTop(injectRequestBase(injectStorageNamespace(guarded.html, id), mountPrefix(id)));
    // First of all: a page about to go to this computer's own page does nothing else.
    return { html: injectShellReturn(browser ? injectFrameBrowser(page, id, browser) : page, id), misses: [...manifest.misses, ...guarded.misses] };
}
/** Reads the Session a page shows, '' when none: the store {@link CURRENT_SESSION_KEY} holds `{ sessionId }`. */
export function currentSession(storage) {
    try {
        const value = JSON.parse(storage.getItem(CURRENT_SESSION_KEY) ?? '{}');
        return typeof value.sessionId === 'string' ? value.sessionId : '';
    }
    catch {
        return '';
    }
}
