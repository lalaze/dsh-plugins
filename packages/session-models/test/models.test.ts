import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSelection } from '../src/client/brands.js';
import { BASE_CSS, badgesOf, buildCss, installOverlay, STYLE_ID, type SessionList, type Sessions } from '../src/client/overlay.js';

const brand = (provider: string, model: string) => describeSelection({ provider, model }).brand;

test('remote CLI routes resolve the native model first, then the CLI', () => {
  assert.deepEqual(describeSelection({ provider: 'remote-cli-claude', model: 'p1/claude/sonnet' }), { brand: 'claude', model: 'sonnet', cli: 'claude' });
  assert.deepEqual(describeSelection({ provider: 'remote-cli-codex', model: 'p1/codex/gpt-5.1-codex' }), { brand: 'openai', model: 'gpt-5.1-codex', cli: 'codex' });
  assert.deepEqual(describeSelection({ provider: 'remote-cli', model: 'p1/dsh/deepseek-chat' }), { brand: 'deepseek', model: 'deepseek-chat', cli: 'dsh' });
  assert.deepEqual(describeSelection({ provider: 'remote-cli-antigravity', model: 'p1/antigravity/gemini-3-pro' }), { brand: 'gemini', model: 'gemini-3-pro', cli: 'antigravity' });
  assert.equal(brand('remote-cli-codebuddy', 'p1/codebuddy/auto'), 'codebuddy');
  assert.equal(brand('remote-cli-dsh', 'p1/dsh/default'), 'deepseek');
  assert.equal(describeSelection({ provider: 'remote-cli-claude', model: 'p1/claude/claude%2Fopus' }).model, 'claude/opus');
  assert.equal(describeSelection({ provider: 'remote-cli-grok', model: 'unexpected' }).cli, 'grok');
});

test('local providers resolve by model name, then provider id', () => {
  assert.equal(brand('deepseek', 'deepseek-chat'), 'deepseek');
  assert.equal(brand('openrouter', 'anthropic/claude-sonnet-4.5'), 'claude');
  assert.equal(brand('claude-ssh-devbox', 'opus'), 'claude');
  assert.equal(brand('openai', 'o4-mini'), 'openai');
  assert.equal(brand('custom', 'o3'), 'openai');
  assert.equal(brand('groq', 'llama-3.3-70b'), 'generic');
  assert.equal(brand('siliconflow', 'deepseek-r1-distill-qwen-32b'), 'deepseek');
  assert.equal(brand('siliconflow', 'Qwen3-Coder'), 'qwen');
  assert.equal(brand('zai', 'glm-4.6'), 'zhipu');
  assert.equal(brand('moonshot', 'k2-turbo'), 'kimi');
  assert.equal(brand('xai', 'grok-code-fast-1'), 'grok');
  assert.equal(brand('volcengine', 'ep-2025'), 'doubao');
  assert.equal(brand('ollama', 'foo1'), 'generic');
});

test('the next selection wins over the last used one', () => {
  const list: SessionList = { projectionsBySession: {
    a: { values: { modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, next: { provider: 'remote-cli-claude', model: 'p/claude/opus' } } } },
    b: { values: { modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, next: null } } },
    c: { values: {} },
  } };
  const badges = badgesOf(list);
  assert.equal(badges.get('a')?.brand, 'claude');
  assert.equal(badges.get('b')?.brand, 'deepseek');
  assert.equal(badges.has('c'), false);
});

test('stylesheet groups rows by brand and skips archived rows and unsafe ids', () => {
  const css = buildCss(new Map([
    ['s-1', { brand: 'claude', model: 'opus' }], ['s-2', { brand: 'claude', model: 'sonnet' }],
    ['s-3', { brand: 'openai', model: 'gpt-5' }], ['bad"]{}*{', { brand: 'grok', model: 'grok-4' }],
  ] as const));
  assert.ok(css.startsWith(BASE_CSS));
  assert.match(css, /\[data-row-key="session:s-1"\]:not\(\[aria-description\]\)>span:first-child,\[data-row-key="session:s-2"\]/);
  assert.match(css, /--dsm-color:#D97757/);
  assert.match(css, /session:s-3[^{]*\{[^}]*--dsm-color:var\(--dsw-alias-label-primary,currentColor\)/);
  assert.doesNotMatch(css, /bad/);
  assert.match(css, /session:s-3"\]:not\(\[aria-description\]\)>span:first-child>svg\[data-state\][^{]*\{color:var\(--dsw-alias-label-primary,currentColor\)\}$/);
  assert.equal(css.split('\n').length, BASE_CSS.split('\n').length + 3);
  assert.equal(buildCss(new Map()), BASE_CSS);
});

function fixture(rowIds: string[], projections: Record<string, { state?: string; values?: object }>) {
  const style = { id: '', textContent: '', removed: false, remove() { this.removed = true; } };
  let observed = false;
  const doc = {
    head: { append: () => {} }, body: {},
    createElement: () => style,
    querySelectorAll: () => rowIds.map(id => ({ getAttribute: () => `session:${id}` })),
    defaultView: { MutationObserver: class { observe() { observed = true; } disconnect() { observed = false; } } },
  };
  const listeners = new Set<() => void>(), requests: string[] = [], pending: (() => void)[] = [];
  let snapshot: SessionList = { projectionsBySession: projections as SessionList['projectionsBySession'] };
  const sessions: Sessions = {
    list: { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    refreshProjections(id) { requests.push(id); return new Promise(resolve => pending.push(resolve)); },
  };
  const publish = (next: SessionList) => { snapshot = next; for (const listener of listeners) listener(); };
  return { doc: doc as unknown as Document, sessions, style, requests, pending, publish, listeners, observed: () => observed };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('visible rows without a model get one bounded projection read each', async () => {
  const opus = { modelSelection: { lastUsed: null, next: { provider: 'remote-cli-claude', model: 'p/claude/opus' } } };
  const f = fixture(['known', 'b', 'c', 'd', 'failed', 'hidden-ready'], {
    known: { state: 'idle', values: opus }, b: { state: 'idle', values: {} }, failed: { state: 'error' }, 'hidden-ready': { state: 'ready' },
  });
  const overlay = installOverlay(f.doc, f.sessions, { concurrency: 2, scanDelay: 0 });
  assert.equal(f.style.id, STYLE_ID);
  assert.match(f.style.textContent, /session:known/);
  assert.equal(overlay.badge('known')?.model, 'opus');
  await tick();
  assert.deepEqual(f.requests, ['b', 'c']);

  let notified = 0; overlay.subscribe(() => { notified++; });
  f.pending.shift()!(); await tick();
  assert.deepEqual(f.requests, ['b', 'c', 'd']);
  f.publish({ projectionsBySession: { known: { values: opus }, b: { state: 'ready', values: opus }, c: { state: 'loading' }, d: { state: 'loading' } } });
  assert.equal(notified, 1);
  assert.match(f.style.textContent, /session:b/);
  await tick();
  assert.deepEqual(f.requests, ['b', 'c', 'd']);

  overlay.dispose();
  assert.equal(f.style.removed, true);
  assert.equal(f.observed(), false);
  assert.equal(f.listeners.size, 0);
});
