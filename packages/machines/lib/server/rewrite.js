/**
 * The DSH 0.2.2 internals a mounted machine's page depends on, all in this file. Each rewrite checks the markup it
 * relies on and leaves the page as DSH served it when that is gone, returning what it found so the host can log it.
 * The desktop guard follows Kivotos (github.com/dsh-labs/kivotos, Apache-2.0), see THIRD_PARTY_NOTICES.md.
 *
 * No Node imports: the client bundle uses some of these names.
 */
/** Where machines are mounted on this host's webServer. */
export const MOUNT_ROOT = '/dsh-machines/peer';
export const mountPrefix = (id) => `${MOUNT_ROOT}/${id}`;
/** A page under a mount: its machine id. */
export function mountedId(pathname) {
    return /^\/dsh-machines\/peer\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathname)?.[1];
}
/** dsh-client-store keeps the current Session here (`{ sessionId }`), restored once at boot. */
export const CURRENT_SESSION_KEY = 'dsh.sessions.current';
/** The localStorage prefix of one machine's page. */
export const storagePrefix = (id) => `dsh-machines:${id}:`;
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
 */
export function guardDesktopBoot(html, prefix) {
    const script = `<script>(()=>{const d=globalThis.${DESKTOP_BRIDGE};if(typeof d!=="object"||d===null||typeof d.ready!=="function")return;const m=${literal(`${prefix}/`)},b=Promise.withResolvers();let t=globalThis.${TRANSPORT};Object.defineProperty(globalThis,"${TRANSPORT}",{configurable:true,enumerable:true,get:()=>t,set(n){if(n!==t&&typeof n==="object"&&n!==null&&"streamBaseUrl" in n)throw new Error("dsh-machines: a machine's page keeps its own boot");t=n}});globalThis.${BOOT_GATE}={promise:b.promise,resolve(){},reject(){}};d.ready().then(r=>{t={...t,ownsHost:true,streamBaseUrl:new URL(m,r.streamBaseUrl).href};b.resolve()},b.reject)})()</script>`;
    const misses = html.includes(BOOT_GATE_TAIL) ? [] : [{ point: 'desktop-boot', reason: html.includes(BOOT_GATE) ? `${BOOT_GATE} is not settled by the 0.2.2 tail script` : `the page has no ${BOOT_GATE}` }];
    return { html: injectHead(html, script), misses };
}
/** Where the namespace script leaves the page's real localStorage, for the switcher to pick another machine's Session. */
export const RAW_STORAGE = '__dshMachinesStorage';
/**
 * Give a mounted page its own localStorage. Every machine's page is served from this host's origin and DSH keeps its
 * stores under fixed keys, so without this two machines' pages would overwrite each other's state.
 */
export function injectStorageNamespace(html, id) {
    const script = `<script>(()=>{const s=window.localStorage,p=${literal(storagePrefix(id))},own=()=>{const k=[];for(let i=0;i<s.length;i++){const n=s.key(i);if(n!==null&&n.startsWith(p))k.push(n.slice(p.length))}return k};const v={getItem:k=>s.getItem(p+k),setItem:(k,x)=>s.setItem(p+k,String(x)),removeItem:k=>s.removeItem(p+k),key:i=>own()[i]??null,clear:()=>{for(const k of own())s.removeItem(p+k)},get length(){return own().length}};Object.defineProperty(window,${literal(RAW_STORAGE)},{configurable:true,value:s});Object.defineProperty(window,"localStorage",{configurable:true,get:()=>v})})()</script>`;
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
 * A machine's index as this host serves it under its mount. Scripts run in head order, so the namespace comes first
 * (everything after it reads the namespaced storage), then the desktop guard.
 */
export function mountedIndex(html, id) {
    const manifest = credentialedManifest(html);
    const guarded = guardDesktopBoot(manifest.html, mountPrefix(id));
    return { html: injectStorageNamespace(guarded.html, id), misses: [...manifest.misses, ...guarded.misses] };
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
