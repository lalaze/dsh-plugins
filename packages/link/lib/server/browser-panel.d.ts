import { Transform, type TransformCallback } from 'node:stream';
import { type Miss } from './rewrite.js';
export declare const BROWSER_ID = "@deepseek-ai/dsh-client-ui-sidebar-browser";
/** Where the listener serves the changed module; the boot row names it relative to the page. */
export declare const PANEL_ROUTE = "/dsh-link/browser-panel.js";
export interface BootEntry {
    id: string;
    url: string;
    rev: string;
    inject?: string[];
}
export interface BootBatch {
    phase: 'application';
    url: string;
    rev: string;
    entries: string[];
}
export interface BrowserPanel {
    /** The module as served, ending the way DSH ends the modules it serves. */
    code: string;
    /** The package version found. */
    version: string;
    entry: BootEntry;
    batch: BootBatch;
}
/** The panel built from the package's module and manifest; misses instead when the module is not the known form. */
export declare function buildPanel(module: string, manifest: {
    version?: unknown;
    dsh?: {
        client?: {
            inject?: unknown;
        };
    };
}): {
    panel?: BrowserPanel;
    misses: Miss[];
};
/**
 * Read the panel from this DSH's install. `from` lists files to resolve the package from (the profile's
 * package.json, the running `dsh` entry by its real path), first found wins.
 */
export declare function loadPanel(from: (string | undefined)[]): {
    panel?: BrowserPanel;
    misses: Miss[];
};
/** Add the panel's row and batch to a boot graph that lacks it; true when it changed. */
export declare function addPanelRow(graph: unknown, panel: BrowserPanel): boolean;
/** The page with the panel's row in its boot graph; a page without the 0.2.2 boot script is left alone and reported. */
export declare function injectPanelBoot(html: string, panel: BrowserPanel): {
    html: string;
    misses: Miss[];
};
/** One SSE event with the panel added when it is a `graph` frame; anything else as it came. */
export declare function panelFrame(event: string, panel: BrowserPanel): string;
/** `/plugins/events` with the panel added to each graph frame; events are cut at blank lines, as SSE does. */
export declare class PanelFrames extends Transform {
    private readonly panel;
    private pending;
    private readonly decoder;
    constructor(panel: BrowserPanel);
    _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void;
    _flush(done: TransformCallback): void;
}
