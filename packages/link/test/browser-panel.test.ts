import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import vm from 'node:vm';
import { addPanelRow, BROWSER_ID, buildPanel, injectPanelBoot, PANEL_ROUTE, PanelFrames, panelFrame, type BrowserPanel } from '../src/browser-panel.js';

const MODULE = readFileSync(new URL('./fixtures/sidebar-browser-client.js', import.meta.url), 'utf8');
const BOOT_PAGE = readFileSync(new URL('./fixtures/dsh-0.2.2-rc.3-boot.html', import.meta.url), 'utf8');
const MANIFEST = { version: '0.2.2-rc.3', dsh: { client: { inject: ['@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-session'] } } };

function panel(): BrowserPanel {
  const built = buildPanel(MODULE, MANIFEST);
  assert.deepEqual(built.misses, []);
  return built.panel!;
}

/** Runs the served module the way DSH's loader does and applies the plugin with `lent` as the window's loan. */
function applyModule(code: string, lent?: unknown): { calls: string[]; element?: unknown } {
  let factory: ((require: (name: string) => unknown) => { apply(ctx: unknown): void }) | undefined;
  const context: Record<string, unknown> = { window: { __ModuleLoader__: { load: (row: { factory: typeof factory }) => { factory = row.factory; } } } };
  if (lent) context.__dshLinkDesktop = lent;
  vm.createContext(context);
  vm.runInContext(code, context);
  const ctx = { calls: [] as string[], element: undefined as unknown };
  factory!(() => ({})).apply(ctx);
  return ctx;
}

test('the served module waits for the window\'s loan, takes its bridge and asks it for the webview', () => {
  const { code, entry, batch, version } = panel();
  assert.equal(version, '0.2.2-rc.3');
  assert.match(code, /function apply\(ctx\)\{if\(!globalThis\.__dshLinkDesktop\)return;/);
  assert.doesNotMatch(code, /globalThis\.dshDesktop/);
  assert.doesNotMatch(code, /document\.createElement\(`webview`\)/);
  assert.doesNotMatch(code, /sourceMappingURL/);
  assert.ok(code.endsWith('\n;\n'));
  // Outside a desktop frame the plugin registers nothing.
  assert.deepEqual(applyModule(code).calls, []);
  const made = { tag: 'webview', attributes: new Map<string, string>(), setAttribute(name: string, value: string) { this.attributes.set(name, value); } };
  const applied = applyModule(code, { protocolVersion: 1, browser: {}, createWebview: () => made });
  assert.deepEqual(applied.calls, ['apply', 'desktop']);
  assert.equal(applied.element, made);
  assert.equal(made.attributes.get('src'), 'about:blank#l1');
  assert.deepEqual(entry, { id: BROWSER_ID, url: `${PANEL_ROUTE.slice(1)}?rev=${entry.rev}`, rev: entry.rev, inject: MANIFEST.dsh.client.inject });
  assert.deepEqual(batch, { phase: 'application', url: entry.url, rev: entry.rev, entries: [BROWSER_ID] });
  assert.match(entry.rev, /^[0-9a-f]{12}$/);
  assert.equal(buildPanel(MODULE, MANIFEST).panel!.entry.rev, entry.rev, 'the same module gives the same revision');
});

test('a module that is not the known form gives no panel and says what is missing', () => {
  const missing = buildPanel(MODULE.replace('const carrier=globalThis.dshDesktop;', 'const carrier=window.dshDesktop;'), MANIFEST);
  assert.equal(missing.panel, undefined);
  assert.deepEqual(missing.misses.map(miss => miss.point), ['panel-bridge']);
  const twice = buildPanel(MODULE.replace('function createIframePage', 'function apply(ctx){}function createIframePage'), MANIFEST);
  assert.deepEqual(twice.misses.map(miss => miss.point), ['panel-apply']);
  assert.match(twice.misses[0]!.reason, /found 2 times/);
});

/** The checks dsh-client-modules' parseBootManifest runs on a graph. */
function assertBootGraph(graph: { entries: { id: string; url: string; rev: string }[]; batches: { phase: string; url: string; rev: string; entries: string[] }[] }): void {
  const ids = new Set<string>();
  for (const entry of graph.entries) { assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`); ids.add(entry.id); assert.match(entry.url, /[?&]rev=/); }
  const owner = new Map<string, string>();
  for (const batch of graph.batches) {
    assert.ok(batch.phase === 'bootstrap' || batch.phase === 'application');
    assert.ok(batch.entries.length > 0);
    for (const id of batch.entries) { assert.ok(ids.has(id), `batch names unknown ${id}`); assert.ok(!owner.has(id), `${id} in two batches`); owner.set(id, batch.url); }
  }
  for (const id of ids) assert.ok(owner.has(id), `${id} in no batch`);
}

const bootOf = (html: string) => JSON.parse(/<script>globalThis\["__DSH_BOOT__"\] = (\{[\s\S]*?\})<\/script>/.exec(html)![1]!);

test('the page\'s boot graph gets the panel row and its batch, once, still a valid graph', () => {
  const p = panel();
  const page = injectPanelBoot(BOOT_PAGE, p);
  assert.deepEqual(page.misses, []);
  const graph = bootOf(page.html);
  const before = bootOf(BOOT_PAGE);
  assert.equal(graph.entries.length, before.entries.length + 1);
  assert.deepEqual(graph.entries.at(-1), p.entry);
  assert.deepEqual(graph.batches.at(-1), p.batch);
  assert.equal(graph.rev, before.rev);
  assert.deepEqual(graph.release, before.release);
  assertBootGraph(graph);
  // The rest of the page is untouched.
  assert.equal(page.html.replace(/<script>globalThis\["__DSH_BOOT__"\][\s\S]*?<\/script>/, ''), BOOT_PAGE.replace(/<script>globalThis\["__DSH_BOOT__"\][\s\S]*?<\/script>/, ''));
  assert.equal(injectPanelBoot(page.html, p).html, page.html, 'a page that lists the panel is left alone');
});

test('a boot graph cannot close its script, and other pages are left alone', () => {
  const p = panel();
  const sneaky = { ...p, entry: { ...p.entry, inject: ['</script><script>alert(1)//'] } };
  const page = injectPanelBoot(BOOT_PAGE, sneaky).html;
  assert.equal(page.match(/<\/script>/g)!.length, BOOT_PAGE.match(/<\/script>/g)!.length);
  assert.deepEqual(injectPanelBoot('<html><head></head></html>', p), { html: '<html><head></head></html>', misses: [] });
  assert.deepEqual(injectPanelBoot('<script>window.__DSH_BOOT__={}</script>', p).misses.map(miss => miss.point), ['panel-boot']);
  assert.equal(addPanelRow({ entries: 'x', batches: [] }, p), false);
});

test('graph frames of the event stream get the panel; other events pass as they came, however the bytes are cut', async () => {
  const p = panel();
  const graph = bootOf(BOOT_PAGE);
  const stream = `: connected\n\ndata: ${JSON.stringify({ type: 'graph', graph })}\n\ndata: {"type":"rebuilt","id":"dsh-link","rev":"ä1"}\n\n`;
  const bytes = Buffer.from(stream, 'utf8');
  for (const size of [1, 7, 64, bytes.length]) {
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
    const out = await text(Readable.from(chunks).pipe(new PanelFrames(p)));
    const events = out.split('\n\n');
    assert.equal(events[0], ': connected');
    const frame = JSON.parse(events[1]!.slice('data: '.length));
    assert.equal(frame.type, 'graph');
    assert.deepEqual(frame.graph.entries.at(-1), p.entry);
    assertBootGraph(frame.graph);
    assert.equal(events[2], 'data: {"type":"rebuilt","id":"dsh-link","rev":"ä1"}');
    assert.equal(events.length, 4);
  }
  assert.equal(panelFrame('data: not json', p), 'data: not json');
  assert.equal(panelFrame('event: x\ndata: {"type":"graph","graph":{"entries":[],"batches":[]}}', p).split('\n')[0], 'event: x');
});
