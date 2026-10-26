import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { LocaleRuntime } from '@dsh-plugins/i18n';
import * as client from '../src/client/index.js';
import { i18n } from '../src/client/i18n.js';

test('settings wait for the native async locale service and follow language switches', async t => {
  const ctx = new Context();
  let release = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  t.after(() => { release(); return ctx.fiber.dispose(); });
  const labels: Array<() => string> = [];
  const slots: client.Client['slots'] = {
    inject: (_name: string, factory: () => void) => factory(),
    register: spec => { const label = spec.label; if (typeof label === 'function') labels.push(() => label()); },
  };
  ctx.provide('slots', slots);
  let active = 'zh';
  const listeners = new Set<() => void>();
  const dictionaries = new Map<string, unknown>();
  const locale: LocaleRuntime = {
    register: (namespace, dict) => {
      dictionaries.set(namespace, dict);
      return () => { dictionaries.delete(namespace); };
    },
    getSnapshot: () => ({ active, revision: 0 }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const host = ctx.plugin({ name: 'async-locale-fixture', async apply(ctx) { await ready; ctx.provide('locale', locale); } });
  const plugin = ctx.plugin({ ...client, apply(ctx) {
    client.apply({ get: name => ctx.get(name), effect: factory => { ctx.effect(factory); }, slots });
  } });
  await setImmediate();
  assert.equal(labels.length, 0, 'settings must not activate before the native language bridge is ready');
  release(); await host.await(); await plugin.await();
  const label = labels[0];
  assert.equal(label(), '远程智能体');
  assert.equal(i18n.ui('Main chat'), '主对话');
  assert.equal(i18n.ui('Discover and add models'), '检测并添加模型');
  assert.equal(i18n.ui('Remote task request failed (503)'), '远程任务请求失败（503）');
  assert.equal(i18n.localizeError(new Error('This main chat project is already saved')), '该主对话项目已保存');
  assert.equal(dictionaries.size, 1);
  let changes = 0;
  const unsubscribe = i18n.subscribe(() => { changes++; });
  active = 'en'; for (const listener of listeners) listener();
  assert.equal(label(), 'Remote agents');
  assert.equal(i18n.ui('Main chat'), 'Main chat');
  active = 'zh-CN'; for (const listener of listeners) listener();
  assert.equal(label(), '远程智能体');
  assert.equal(changes, 2);
  unsubscribe(); await plugin.dispose();
  assert.equal(dictionaries.size, 0);
  assert.equal(listeners.size, 0);
});

test('the DSH client manifest loads the locale package before remote settings', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
});
