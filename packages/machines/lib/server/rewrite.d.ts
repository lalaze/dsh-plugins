/**
 * The DSH 0.2.2 internals a mounted machine's page depends on, all in this file. Each rewrite checks the markup it
 * relies on and leaves the page as DSH served it when that is gone, returning what it found so the host can log it.
 * The desktop guard follows Kivotos (github.com/dsh-labs/kivotos, Apache-2.0), see THIRD_PARTY_NOTICES.md.
 *
 * No Node imports: the client bundle uses some of these names.
 */
/** Where machines are mounted on this host's webServer. */
export declare const MOUNT_ROOT = "/dsh-machines/peer";
export declare const mountPrefix: (id: string) => string;
/** A page under a mount: its machine id. */
export declare function mountedId(pathname: string): string | undefined;
/** dsh-client-store keeps the current Session here (`{ sessionId }`), restored once at boot. */
export declare const CURRENT_SESSION_KEY = "dsh.sessions.current";
/** The localStorage prefix of one machine's page. */
export declare const storagePrefix: (id: string) => string;
/** A rewrite that did not find what it relies on. */
export interface Miss {
    point: string;
    reason: string;
}
export interface Rewritten {
    html: string;
    misses: Miss[];
}
/** A script as early as possible in the head, before any of DSH's own. */
export declare function injectHead(html: string, script: string): string;
/**
 * Pages served through this plugin belong to the same tailnet user, so they get the operator surface a loopback page
 * gets (`isLoopback` in dsh-client-connection reads `ownsHost`).
 */
export declare function injectOwnsHost(html: string): string;
/** Browsers fetch a manifest without cookies, and every path under a mount is behind the fence. */
export declare function credentialedManifest(html: string): Rewritten;
/**
 * Keep the desktop app's own boot out of a mounted page. The desktop shell exposes `dshDesktopBoot` to every page of
 * `dsh-app://app`; DSH's web entry would apply this computer's boot rows and stream URL on top of the machine's own.
 * The guard takes the handshake itself, rebases the stream URL under the mount, holds the boot gate until then and
 * refuses the entry's own transport. Outside the desktop window (a browser, the phone) it does nothing.
 */
export declare function guardDesktopBoot(html: string, prefix: string): Rewritten;
/** Where the namespace script leaves the page's real localStorage, for the switcher to pick another machine's Session. */
export declare const RAW_STORAGE = "__dshMachinesStorage";
/**
 * Give a mounted page its own localStorage. Every machine's page is served from this host's origin and DSH keeps its
 * stores under fixed keys, so without this two machines' pages would overwrite each other's state.
 */
export declare function injectStorageNamespace(html: string, id: string): string;
/** The page's real localStorage: the namespace script's copy on a mounted page, else the page's own. */
export declare function rawStorage(): Storage;
/** Make a Session the one a machine's page restores at its next boot ('' as id: this host's own page). */
export declare function selectSession(storage: Storage, machineId: string, sessionId: string): void;
/**
 * A machine's index as this host serves it under its mount. Scripts run in head order, so the namespace comes first
 * (everything after it reads the namespaced storage), then the desktop guard.
 */
export declare function mountedIndex(html: string, id: string): Rewritten;
/** Reads the Session a page shows, '' when none: the store {@link CURRENT_SESSION_KEY} holds `{ sessionId }`. */
export declare function currentSession(storage: {
    getItem(key: string): string | null;
}): string;
