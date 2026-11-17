/**
 * The DSH 0.2.2 internals a mounted machine's page depends on, all in this file. Each rewrite checks the markup it
 * relies on and leaves the page as DSH served it when that is gone, returning what it found so the host can log it.
 * The desktop guard follows Kivotos (github.com/dsh-labs/kivotos, Apache-2.0), see THIRD_PARTY_NOTICES.md.
 *
 * No Node imports: the client bundle uses some of these names.
 */
/** Where machines are mounted on this host's webServer. */
export declare const MOUNT_ROOT = "/dsh-link/peer";
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
 *
 * A machine's page kept in a frame of the desktop window (see client/shell.ts) has no bridge of its own: the shell
 * already booted, so the guard takes the stream URL the window's page got and rebases it the same way.
 */
export declare function guardDesktopBoot(html: string, prefix: string): Rewritten;
/** The window's own page keeps the machines it shows in frames (client/shell.ts); these keys are shared with it. */
export declare const SHELL_KEYS: {
    readonly keepPages: "dsh-link:keep-pages";
    readonly shown: "dsh-link:shown";
    readonly direct: "dsh-link:direct";
    readonly returned: "dsh-link:returned";
};
/**
 * A machine's page opened as the window's page (by its address, a bookmark, a reload of a page an older version
 * opened) goes to this computer's own page, which shows the machine in a frame: otherwise switching away from it loads
 * a whole page every time. Not when keeping pages is off (by choice, or by default over HTTP/1.1: see client/shell.ts),
 * nor for the machine the user chose to open directly.
 */
export declare function injectShellReturn(html: string, id: string): string;
/** The global a window's own page keeps its shell on (client/shell.ts). */
export declare const SHELL_GLOBAL = "__dshLinkShell";
/** On the shell page's root: the height of the title strip over its frames in a desktop window (client/styles.ts). */
export declare const BAR_HEIGHT = "--dl-bar-height";
/**
 * A machine's page in a frame of the desktop window fills the whole window, so its background (and a wallpaper) reaches
 * the top as on the window's own page. The shell's see-through title strip lies over the top band: the page starts
 * below it, and its menus and dialogs keep clear of it. The band follows the window (none in full screen).
 */
export declare function injectFrameTop(html: string): string;
/** Where the namespace script leaves the page's real localStorage, for the switcher to pick another machine's Session. */
export declare const RAW_STORAGE = "__dshLinkStorage";
/**
 * Give a mounted page its own localStorage. Every machine's page is served from this host's origin and DSH keeps its
 * stores under fixed keys, so without this two machines' pages would overwrite each other's state.
 */
export declare function injectStorageNamespace(html: string, id: string): string;
/**
 * Send a mounted page's requests by absolute path to its machine. DSH's own requests are relative to the page or go
 * through the rebased stream, but plugins call their routes by absolute path (`fetch('/api/remote-agents')`), which on
 * this host's origin reaches this computer's DSH: the Mac mini's model picker asked the MacBook's remote-agents which
 * machines fit a Mac mini conversation, got none and hid every remote CLI. Same-origin paths outside `/dsh-link/` (this
 * host's switcher and attention routes, and the mounts) get the mount prefix in fetch, XMLHttpRequest, EventSource and
 * sendBeacon. Element URLs, `import()` and WebSocket are left alone: the only upgrade a mount forwards is DSH's stream.
 */
export declare function injectRequestBase(html: string, prefix: string): string;
/** The page's real localStorage: the namespace script's copy on a mounted page, else the page's own. */
export declare function rawStorage(): Storage;
/** Make a Session the one a machine's page restores at its next boot ('' as id: this host's own page). */
export declare function selectSession(storage: Storage, machineId: string, sessionId: string): void;
/**
 * A machine's index as this host serves it under its mount. Scripts run in head order, so the request base and the
 * namespace come first (everything after them requests from the machine and reads the namespaced storage), then the
 * desktop guard.
 */
export declare function mountedIndex(html: string, id: string): Rewritten;
/** Reads the Session a page shows, '' when none: the store {@link CURRENT_SESSION_KEY} holds `{ sessionId }`. */
export declare function currentSession(storage: {
    getItem(key: string): string | null;
}): string;
