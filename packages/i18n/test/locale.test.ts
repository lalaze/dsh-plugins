import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createI18n, fill, languageOf } from '../src/index.js';

test('English fallback, host preference, interpolation, live switches and disposal', () => {
  const i18n = createI18n('test-plugin', { 'Hello {name}': '你好，{name}', 'Request failed ({0})': '请求失败（{0}）' });
  assert.equal(i18n.ui('Hello {name}', { name: 'Alex' }), 'Hello Alex');
  let active = 'zh-CN';
  const subscriptions = new Set<() => void>();
  let registered = false;
  let changes = 0;
  const unsubscribe = i18n.subscribe(() => { changes++; });
  const dispose = i18n.installLocale({ get: () => ({
    getSnapshot: () => ({ active, revision: 0 }),
    subscribe: listener => { subscriptions.add(listener); return () => { subscriptions.delete(listener); }; },
    register: (namespace, dictionaries) => {
      assert.equal(namespace, 'test-plugin');
      assert.equal(dictionaries.en['Hello {name}'], 'Hello {name}');
      assert.equal(dictionaries.zh['Hello {name}'], '你好，{name}');
      registered = true;
      return () => { registered = false; };
    },
  }) });
  assert.equal(i18n.formatLocale(), 'zh-CN');
  assert.equal(i18n.ui('Hello {name}', { name: 'Alex' }), '你好，Alex');
  assert.equal(i18n.localizeError(new Error('Request failed (503)')), '请求失败（503）');
  assert.equal(i18n.ui('User content with <markup>'), 'User content with <markup>');
  assert.equal(i18n.ui('Hello {name}'), '你好，{name}');
  active = 'en'; for (const listener of subscriptions) listener();
  assert.equal(i18n.localizeError(new Error('Request failed (503)')), 'Request failed (503)');
  active = 'fr'; for (const listener of subscriptions) listener();
  assert.equal(i18n.formatLocale(), 'en-US');
  assert.ok(changes >= 3);
  dispose(); unsubscribe();
  assert.equal(registered, false);
  assert.equal(subscriptions.size, 0);
  assert.equal(i18n.ui('Hello {name}', { name: 'Alex' }), 'Hello Alex');
  i18n.installLocale({})();
});

test('language tags and placeholders have safe English defaults', () => {
  for (const tag of [undefined, '', 'en-US', 'fr-FR', 'zhang']) assert.equal(languageOf(tag), 'en');
  for (const tag of ['zh', 'zh-CN', 'zh_TW', 'ZH-Hant']) assert.equal(languageOf(tag), 'zh');
  assert.equal(fill('{toString} {name}', { name: '$&' }), '{toString} $&');
});

test('every plugin translation preserves placeholders and supplies both languages', async () => {
  const root = new URL('../../', import.meta.url);
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const name of ['gallery', 'usage-stats', 'translate']) {
    const path = new URL(`${name}/src/client/locales.ts`, root);
    const source = await readFile(path, 'utf8');
    const dictionary = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1)) as Record<string, string>;
    for (const [en, zh] of Object.entries(dictionary)) {
      assert.ok(en.trim(), `${name}: empty English string`);
      assert.ok(zh.trim(), `${name}: missing Chinese for ${en}`);
      assert.deepEqual(placeholders(en), placeholders(zh), `${name}: ${en}`);
    }
  }
});
