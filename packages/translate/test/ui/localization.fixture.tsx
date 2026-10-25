import React from 'react';
import { createRoot } from 'react-dom/client';
import { apply as applyTranslation } from '../../src/client/index.js';
import { apply as applyDevTools } from '../../../browser-devtools/src/client/index.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';

const locale = createLocaleFixture('en');
const cleanups: Array<() => void> = [];
const fixture = { setLocale: locale.setLocale, fail: false, requests: 0 };
Object.assign(window, { fixture });
window.fetch = async () => {
  fixture.requests++;
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
};
applyTranslation(ctx);
createRoot(mount).render(<><Settings /><textarea data-composer-input aria-label="Draft" defaultValue="你好世界" /><Composer /></>);

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
