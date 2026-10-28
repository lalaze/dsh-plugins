import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULTS, readPreferences, savePreferences } from '../src/client/preferences.js';
import { UsageSettings } from '../src/client/settings.js';

class MemoryStorage { items = new Map<string, string>(); getItem(key: string) { return this.items.get(key) ?? null; } setItem(key: string, value: string) { this.items.set(key, value); } }
const install = (value: unknown) => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

test('the header pill is shown by default and the switch is saved for this device', () => {
  const storage = new MemoryStorage(); install(storage);
  assert.deepEqual(readPreferences(), DEFAULTS);
  savePreferences({ headerBadge: false });
  assert.equal(readPreferences().headerBadge, false);
  assert.deepEqual(JSON.parse(storage.getItem('dsh-usage-stats.preferences')!), { headerBadge: false });
});

test('malformed or blocked storage falls back to the defaults, and a blocked write lasts until reload', () => {
  const storage = new MemoryStorage(); storage.setItem('dsh-usage-stats.preferences', '{not json'); install(storage);
  assert.deepEqual(readPreferences(), DEFAULTS);
  install({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.deepEqual(readPreferences(), DEFAULTS);
  savePreferences({ headerBadge: false });
  assert.equal(readPreferences().headerBadge, false);
});

test('Settings lists settings only; the statistics open in a window', () => {
  const html = renderToStaticMarkup(createElement(UsageSettings, { details: () => createElement('p', null, 'DASHBOARD') }));
  assert.doesNotMatch(html, /DASHBOARD/, 'the dashboard is not rendered in Settings');
  assert.match(html, /role="switch" aria-checked="true" aria-label="Show today&#x27;s usage in the conversation header"/);
  assert.match(html, /aria-haspopup="dialog"[^>]*>Open</);
  assert.match(html, /Stored locally/);
});
