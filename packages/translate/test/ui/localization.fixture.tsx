import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply as applyTranslation } from '../../src/client/index.js';
import { apply as applyDevTools } from '../../../browser-devtools/src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';

const locale = createLocaleFixture('en');
const cleanups: Array<() => void> = [];
// The composer starts on a remote Claude model, which the default keywords lock to English.
let models = { current: { provider: 'remote-cli-claude', model: 'p1/claude/sonnet' } };
const modelListeners = new Set<() => void>();
const modelStore = { getSnapshot: () => models, subscribe(listener: () => void) { modelListeners.add(listener); return () => { modelListeners.delete(listener); }; } };
const fixture = {
  setLocale: locale.setLocale, fail: false, requests: 0, lastTarget: '', lastText: '',
  defer: false, resolveTranslation: () => {}, setDraft: (_text: string) => {}, draft: '你好世界',
  setModel(provider: string, model: string) { models = { current: { provider, model } }; for (const listener of modelListeners) listener(); },
};
Object.assign(window, { fixture });
window.fetch = async (_input, init) => {
  fixture.requests++;
  fixture.lastTarget = JSON.parse(String(init?.body ?? '{}')).target ?? '';
  fixture.lastText = JSON.parse(String(init?.body ?? '{}')).text ?? '';
  if (fixture.defer) await new Promise<void>(resolve => { fixture.resolveTranslation = resolve; });
  return fixture.fail ? Response.json({ error: 'Enter a translation model first' }, { status: 400 })
    : Response.json({ translation: 'Hello world', target: 'en', model: 'fixture-model', detectedLanguage: 'zh-CN', note: null });
};
const mount = document.createElement('div'); document.body.append(mount);
let Settings!: React.FC; let Composer!: React.FC;
const ctx = {
  get: new URLSearchParams(location.search).has('noLocale') ? undefined : () => locale,
  effect: (setup: () => () => void) => { cleanups.push(setup()); },
  slots: { inject: (_name: string, setup: () => void) => setup(), register: (spec: Record<string, unknown>, component: React.FC) => {
    if (spec.name === 'settings.section') Settings = component;
    else Composer = component;
  } },
  inject: (_services: string[], setup: (scoped: never) => void) => setup({ ...ctx, modelDirectories: { directoryFor: () => ({ store: modelStore }) } } as never),
};
applyTranslation(ctx);
const ComposerSeat = Composer as React.FC<{ sessionId: string }>;
function ControlledComposer() {
  const [draft, setDraft] = useState('你好世界');
  fixture.setDraft = setDraft;
  fixture.draft = draft;
  return <div data-composer-card><textarea data-fixture-composer placeholder="输入消息" value={draft} onChange={event => setDraft(event.target.value)} /><ComposerSeat sessionId="session-1" /></div>;
}
// A mounted inactive composer must never receive another composer's translation.
createRoot(mount).render(<><Settings /><div hidden><textarea aria-label="Message" defaultValue="另一个会话的草稿" /></div><ControlledComposer /></>);

// Execute the real serialized debugger in a separate page, as Electron's webview does.
const container = document.createElement('div');
container.innerHTML = '<form><input aria-label="Browser URL" /></form><webview data-sidebar-browser-frame="webview"></webview><iframe title="Guest page"></iframe>';
document.body.append(container);
const frame = container.querySelector('iframe')!;
frame.contentDocument!.body.textContent = 'Guest content';
const view = container.querySelector('webview')!;
Object.assign(view, { getURL: () => 'https://guest.test/', executeJavaScript: async (script: string) => (frame.contentWindow as Window & typeof globalThis).eval(script) });
applyDevTools(ctx);
window.addEventListener('beforeunload', () => { for (const cleanup of cleanups.reverse()) cleanup(); });
