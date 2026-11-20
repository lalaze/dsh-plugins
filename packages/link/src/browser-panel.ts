/**
 * DSH's browser panel on this machine's pages as another machine's desktop window shows them.
 *
 * DSH mounts `@deepseek-ai/dsh-client-ui-sidebar-browser` only in a profile named `desktop`, so a web DSH never lists
 * it and its module answers 404. A page of this machine framed in a desktop window can still use the window's own
 * browser (the window's DSH Link lends it as `globalThis.__dshLinkDesktop`, see frame/browser.ts). So the listener,
 * which serves this machine's pages to the other machines and to no one else, adds the panel to those pages:
 *
 * - the module, read from this DSH's own install, with three changes: it does nothing unless the window lent its
 *   browser (a plain browser or a phone showing the page through a mount gets no panel), it takes the lent bridge
 *   instead of `dshDesktop`, and it asks the lent bridge for its `<webview>` (Electron defines that tag in the
 *   window's main frame only);
 * - its row and a one-row batch in the page's boot graph (`globalThis["__DSH_BOOT__"]`, dsh-client-modules'
 *   `WebBootGraph`), and in every graph frame of `/plugins/events`: the page reconciles its rows against each frame
 *   and would drop one the frame does not list. The stream sends one as soon as it opens.
 *
 * Each change checks the text it relies on (found once in 0.2.2-rc.3 and rc.5); when one is missing nothing is added
 * and the miss is logged.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { DESKTOP_GLOBAL, type Miss } from './rewrite.js';

export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser';
/** Where the listener serves the changed module; the boot row names it relative to the page. */
export const PANEL_ROUTE = '/dsh-link/browser-panel.js';

const CHANGES = [
  { point: 'panel-apply', from: 'function apply(ctx){', to: `function apply(ctx){if(!globalThis.${DESKTOP_GLOBAL})return;` },
  { point: 'panel-bridge', from: 'const carrier=globalThis.dshDesktop;', to: `const carrier=globalThis.${DESKTOP_GLOBAL};` },
  { point: 'panel-webview', from: 'document.createElement(`webview`)', to: `globalThis.${DESKTOP_GLOBAL}.createWebview()` },
] as const;

export interface BootEntry { id: string; url: string; rev: string; inject?: string[] }
export interface BootBatch { phase: 'application'; url: string; rev: string; entries: string[] }

export interface BrowserPanel {
  /** The module as served, ending the way DSH ends the modules it serves. */
  code: string;
  /** The package version found. */
  version: string;
  entry: BootEntry;
  batch: BootBatch;
}

const count = (text: string, part: string) => text.split(part).length - 1;

/** The panel built from the package's module and manifest; misses instead when the module is not the known form. */
export function buildPanel(module: string, manifest: { version?: unknown; dsh?: { client?: { inject?: unknown } } }): { panel?: BrowserPanel; misses: Miss[] } {
  const misses: Miss[] = [];
  let code = module;
  for (const change of CHANGES) {
    const found = count(code, change.from);
    if (found !== 1) { misses.push({ point: change.point, reason: `\`${change.from}\` found ${found} times in ${BROWSER_ID}` }); continue; }
    code = code.replace(change.from, change.to);
  }
  if (misses.length) return { misses };
  // Its source map is not served here; DSH appends `;` after every module it serves.
  code = `${code.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, '')}\n;\n`;
  const rev = createHash('sha256').update(code).digest('hex').slice(0, 12);
  const url = `${PANEL_ROUTE.slice(1)}?rev=${rev}`;
  const inject = manifest.dsh?.client?.inject;
  const entry: BootEntry = { id: BROWSER_ID, url, rev, ...(Array.isArray(inject) && inject.every(name => typeof name === 'string') ? { inject: [...inject] as string[] } : {}) };
  return { panel: { code, version: String(manifest.version ?? ''), entry, batch: { phase: 'application', url, rev, entries: [BROWSER_ID] } }, misses };
}

/** The bundle that lists the panel: an install that hides it from `dsh` itself still has it there. */
const WEB_APP = '@deepseek-ai/dsh-web-app';

function resolveManifest(file: string): string | undefined {
  try { return createRequire(file).resolve(`${BROWSER_ID}/package.json`); } catch { /* try through the bundle */ }
  try { return createRequire(createRequire(file).resolve(`${WEB_APP}/package.json`)).resolve(`${BROWSER_ID}/package.json`); } catch { return undefined; }
}

/**
 * Read the panel from this DSH's install. `from` lists files to resolve the package from (the profile's
 * package.json, the running `dsh` entry by its real path), first found wins.
 */
export function loadPanel(from: (string | undefined)[]): { panel?: BrowserPanel; misses: Miss[] } {
  for (const file of from) {
    if (!file) continue;
    const manifestPath = resolveManifest(file);
    if (!manifestPath) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown; exports?: Record<string, unknown>; dsh?: { client?: { inject?: unknown } } };
      const client = manifest.exports?.['./client'];
      const relative = typeof client === 'string' ? client : typeof (client as { default?: unknown } | undefined)?.default === 'string' ? (client as { default: string }).default : './lib/client.js';
      return buildPanel(readFileSync(join(dirname(manifestPath), relative), 'utf8'), manifest);
    } catch (error) {
      return { misses: [{ point: 'panel-module', reason: `${BROWSER_ID} could not be read: ${(error as Error).message}` }] };
    }
  }
  return { misses: [{ point: 'panel-module', reason: `${BROWSER_ID} is not installed with this DSH` }] };
}

/** Add the panel's row and batch to a boot graph that lacks it; true when it changed. */
export function addPanelRow(graph: unknown, panel: BrowserPanel): boolean {
  if (typeof graph !== 'object' || graph === null) return false;
  const { entries, batches } = graph as { entries?: unknown; batches?: unknown };
  if (!Array.isArray(entries) || !Array.isArray(batches)) return false;
  if (entries.some(row => (row as { id?: unknown } | null)?.id === BROWSER_ID)) return false;
  entries.push({ ...panel.entry });
  batches.push({ ...panel.batch, entries: [...panel.batch.entries] });
  return true;
}

const BOOT = /<script>globalThis\["__DSH_BOOT__"\] = (\{[\s\S]*?\})<\/script>/;
const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/** The page with the panel's row in its boot graph; a page without the 0.2.2 boot script is left alone and reported. */
export function injectPanelBoot(html: string, panel: BrowserPanel): { html: string; misses: Miss[] } {
  const match = BOOT.exec(html);
  if (!match) return { html, misses: html.includes('__DSH_BOOT__') ? [{ point: 'panel-boot', reason: 'the boot graph is not the 0.2.2 form' }] : [] };
  let graph: unknown;
  try { graph = JSON.parse(match[1]!); } catch { return { html, misses: [{ point: 'panel-boot', reason: 'the boot graph is not JSON' }] }; }
  if (!addPanelRow(graph, panel)) return { html, misses: [] };
  return { html: html.slice(0, match.index) + `<script>globalThis["__DSH_BOOT__"] = ${json(graph)}</script>` + html.slice(match.index + match[0].length), misses: [] };
}

/** One SSE event with the panel added when it is a `graph` frame; anything else as it came. */
export function panelFrame(event: string, panel: BrowserPanel): string {
  const lines = event.split('\n');
  const data = lines.filter(line => line.startsWith('data:'));
  if (data.length !== 1) return event;
  let frame: { type?: unknown; graph?: unknown };
  try { frame = JSON.parse(data[0]!.slice(5).trimStart()) as typeof frame; } catch { return event; }
  if (frame?.type !== 'graph' || !addPanelRow(frame.graph, panel)) return event;
  return lines.map(line => line === data[0] ? `data: ${JSON.stringify(frame)}` : line).join('\n');
}

/** `/plugins/events` with the panel added to each graph frame; events are cut at blank lines, as SSE does. */
export class PanelFrames extends Transform {
  private pending = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly panel: BrowserPanel) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    // DSH ends its lines with LF only (client-hmr's sseData).
    this.pending += this.decoder.decode(chunk, { stream: true });
    let end: number;
    let out = '';
    while ((end = this.pending.indexOf('\n\n')) >= 0) {
      out += `${panelFrame(this.pending.slice(0, end), this.panel)}\n\n`;
      this.pending = this.pending.slice(end + 2);
    }
    if (out) this.push(out);
    done();
  }

  override _flush(done: TransformCallback): void {
    const rest = this.pending + this.decoder.decode();
    if (rest) this.push(rest);
    done();
  }
}
