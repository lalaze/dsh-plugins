import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import * as translation from '../../src/client/index.js';
import * as usage from '../../../usage-stats/src/client/index.js';
import { parseQuery, report } from '../../../usage-stats/src/domain.js';
import { createLocaleFixture } from '../../../../scripts/locale-fixture.js';

const locale = createLocaleFixture('zh-CN');
const ctx = new Context();
const entries = new Map<string, { label: () => string; Component: React.FC }>();
const mount = document.createElement('div'); document.body.append(mount);
const root = createRoot(mount);
function Settings() {
  useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().active);
  return <><nav>{[...entries].map(([id, entry]) => <button key={id} data-plugin={id}>{entry.label()}</button>)}</nav>
    {[...entries].map(([id, { Component }]) => <div key={id} data-settings={id}><Component /></div>)}</>;
}
const render = () => root.render(<Settings />);
const slots = {
  inject: (_name: string, setup: () => void) => setup(),
  register(spec: Record<string, unknown>, Component: React.FC) {
    if (spec.name !== 'settings.section' || typeof spec.label !== 'function') return;
    const id = String(spec.id), label = spec.label;
    entries.set(id, { label: () => label(), Component });
    render();
  },
};
ctx.provide('slots', slots);
window.fetch = async input => Response.json(report([], parseQuery(new URL(String(input), 'http://fixture.test'))));
let release = () => {};
const ready = new Promise<void>(resolve => { release = resolve; });
const host = ctx.plugin({ name: 'async-locale-fixture', async apply(scoped) {
  await ready;
  scoped.provide('locale', locale);
} });
const plugins = [translation, usage].map(client => ctx.plugin({ ...client, apply(scoped) {
  client.apply({
    get: name => scoped.get(name),
    effect: setup => { scoped.effect(setup); },
    slots,
  });
} }));
Object.assign(window, { fixture: {
  setLocale: locale.setLocale,
  async startLocale() {
    release(); await host.await();
    for (const plugin of plugins) await plugin.await();
    render();
  },
} });
render();
// Signal only after Cordis has had a turn to activate plugins with missing dependencies.
setTimeout(() => { document.body.dataset.fixtureReady = ''; }, 0);
window.addEventListener('beforeunload', () => { release(); root.unmount(); void ctx.fiber.dispose(); });
