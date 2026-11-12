import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useEffect } from 'react';
import type { Root } from 'react-dom/client';
import { TuiTerminal } from '../src/client/tui.js';
import { TuiUploads } from '../src/client/tui-files.js';
import { KeptTerminals } from '../src/client/tui-kept.js';
import { TuiPrompts } from '../src/client/tui-prompt.js';
import { TuiRenderChoices } from '../src/client/tui-render.js';
import { TuiScrollChoice } from '../src/client/tui-scroll.js';

type Props = Parameters<typeof TuiTerminal>[0];
type State = { phase: string; writable: boolean; issue?: string; info: { state: string }; frame: number };
let root: Root | undefined, container: HTMLElement;
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  for (const name of globals) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (window as unknown as Record<string, unknown>)[name] });
  }
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  mock.timers.reset();
  window.close();
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name];
  }
});

function rig() {
  let state: State = { phase: 'connected', writable: true, info: { state: 'running' }, frame: 0 };
  const listeners = new Set<() => void>(), themeListeners = new Set<() => void>();
  let theme = { fontFamilies: { terminal: 'mono' } };
  const counts = { wrapper: 0, body: 0, subscribed: 0, unsubscribed: 0, viewEffect: 0, tabEffect: 0, terminalEffect: 0, themeEffect: 0, connect: 0, restart: 0 };
  const store = {
    subscribe(listener: () => void) {
      assert.equal(this, store, 'the host store keeps its receiver');
      counts.subscribed++; listeners.add(listener);
      return () => { counts.unsubscribed++; listeners.delete(listener); };
    },
    getSnapshot() { assert.equal(this, store); return state; },
  };
  const model = { state: store, connect() { counts.connect++; } };
  function Body(props: { view(): unknown; useTabInfo(): { tab: { visible: boolean; actions: { openTab(): void } } }; useTerminal(): State; useTheme(select: (value: unknown) => unknown): unknown }) {
    counts.body++;
    const terminal = props.useTerminal(), tab = props.useTabInfo().tab;
    const currentTheme = props.useTheme(value => value) as typeof theme;
    useEffect(() => { counts.viewEffect++; }, [props.view]);
    useEffect(() => { counts.tabEffect++; }, [props.useTabInfo]);
    useEffect(() => { counts.terminalEffect++; }, [props.useTerminal]);
    useEffect(() => { counts.themeEffect++; }, [props.useTheme]);
    return <div data-frame={terminal.frame} data-visible={String(tab.visible)} data-font={currentTheme.fontFamilies.terminal} />;
  }
  const host = document.createElement('div'); document.body.append(host);
  const kept = new KeptTerminals<HTMLElement>(6, document.body, () => document.createElement('div'), { load: () => 0, save() {} });
  kept.restart = () => { counts.restart++; };
  const services: Props['services'] = {
    slots: { entries() { counts.wrapper++; return [{ options: { key: '@deepseek-ai/dsh-client-ui-sidebar-terminal' }, component: Body }]; }, inject() {}, register() {}, subscribe: () => () => {} },
    terminals: { view: () => model, launchShells: async () => ({ shells: [] }), close() {} },
    uploads: new TuiUploads(async () => '/uploaded'), prompts: new TuiPrompts(), t: {}, title: () => undefined, cli: () => 'claude', kept, shells: new Map(),
    render: new TuiRenderChoices({ getItem: () => null, setItem() {} }),
    scroll: new TuiScrollChoice(async () => {}, { getItem: () => null, setItem() {} }), running: () => false,
    theme: { getSnapshot: () => theme, subscribe: listener => { themeListeners.add(listener); return () => { themeListeners.delete(listener); }; } },
  };
  let item: Props['item'] = { sessionId: 'a', host, shell: '/shell', generation: 0, visible: false };
  const render = async (change: Partial<Props['item']> = {}) => {
    item = { ...item, ...change };
    if (!root) { const { createRoot } = await import('react-dom/client'); root = createRoot(container); }
    await act(async () => root!.render(<TuiTerminal key={item.generation} item={item} services={services} />));
  };
  const update = async (change: Partial<State>) => act(async () => { state = { ...state, ...change }; for (const listener of [...listeners]) listener(); });
  const changeTheme = async () => act(async () => { theme = { fontFamilies: { terminal: 'other-mono' } }; for (const listener of themeListeners) listener(); });
  return { render, update, changeTheme, counts, listeners, themeListeners, host, prompts: services.prompts };
}

test('output snapshots reach the body without rerendering its wrapper or replacing host hooks', async () => {
  const r = rig(); await r.render();
  // Let the one-shot remembered-shell listener finish before measuring subscription churn.
  await r.update({ frame: 1 });
  const before = { ...r.counts };
  for (let frame = 2; frame <= 31; frame++) {
    await r.update({ frame });
    assert.equal(container.firstElementChild?.getAttribute('data-frame'), String(frame));
  }
  assert.equal(r.counts.wrapper, before.wrapper);
  assert.equal(r.counts.body, before.body + 30, 'all output/ACK-shaped snapshots still reach the host body');
  for (const key of ['subscribed', 'unsubscribed', 'viewEffect', 'tabEffect', 'terminalEffect', 'themeEffect'] as const) assert.equal(r.counts[key], before[key], key);
  assert.equal(r.counts.connect, 0);
});

test('visibility reconnects only on return, while missing-terminal and theme changes remain live', async () => {
  const r = rig(); await r.render();
  await r.update({ phase: 'failed', writable: false });
  assert.equal(r.counts.connect, 0, 'a hidden terminal does not reconnect');
  await r.render({ visible: true });
  assert.equal(r.counts.connect, 1);
  assert.equal(container.firstElementChild?.getAttribute('data-visible'), 'true');
  await r.update({ frame: 2 });
  assert.equal(r.counts.connect, 1, 'output does not restart a connection');
  await r.update({ issue: 'missingTerminal' });
  assert.equal(r.counts.restart, 1);
  await r.update({ frame: 3 });
  assert.equal(r.counts.restart, 1, 'the same issue is not repeatedly handled on output');
  await r.changeTheme();
  assert.match(container.firstElementChild?.getAttribute('data-font') ?? '', /other-mono/);
  assert.equal(r.counts.viewEffect, 1);
  assert.equal(r.counts.terminalEffect, 1);
  assert.equal(r.counts.themeEffect, 1);
  await r.render({ visible: false });
  await r.update({ issue: undefined, phase: 'connected', writable: false });
  await r.render({ visible: true });
  assert.equal(r.counts.connect, 2, 'returning to a running but read-only attachment reconnects too');
  await act(async () => root!.unmount()); root = undefined;
  assert.equal(r.listeners.size, 0);
  assert.equal(r.themeListeners.size, 0);
});

test('generation replacement releases the old subscriptions and opens a fresh wrapper', async () => {
  const r = rig(); await r.render(); await r.update({ frame: 1 });
  assert.equal(r.listeners.size, 2, 'wrapper issue and body snapshot subscriptions');
  await r.render({ generation: 1 });
  await r.update({ frame: 2 });
  assert.equal(r.listeners.size, 2);
  assert.equal(container.firstElementChild?.getAttribute('data-frame'), '2');
  assert.equal(r.counts.viewEffect, 2);
});

/** Where xterm takes typing and pastes; jsdom has neither a clipboard event nor its data. */
function terminalInput(host: HTMLElement) {
  const pastes: string[] = [];
  class Data { private text = ''; setData(_format: string, text: string) { this.text = text; } getData() { return this.text; } }
  class Paste extends window.Event { clipboardData: Data; constructor(type: string, init: EventInit & { clipboardData: Data }) { super(type, init); this.clipboardData = init.clipboardData; } }
  Object.assign(globalThis, { DataTransfer: Data, ClipboardEvent: Paste });
  const input = document.createElement('textarea'); input.className = 'xterm-helper-textarea';
  input.addEventListener('paste', event => pastes.push((event as unknown as Paste).clipboardData.getData()));
  host.append(input);
  return pastes;
}
const tick = (ms: number) => act(async () => { mock.timers.tick(ms); });

test('text another plugin offers is typed at the prompt once the terminal can take input, whether or not it is on screen', async t => {
  t.after(() => { for (const name of ['DataTransfer', 'ClipboardEvent']) delete (globalThis as Record<string, unknown>)[name]; });
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const r = rig(); await r.render();
  const pastes = terminalInput(r.host);
  await r.update({ writable: false });
  let taken: boolean | undefined;
  await act(async () => { void r.prompts.add('a', 'Redraw these images.\n\n- art/a.png').then(value => { taken = value; }); });
  await tick(150); await tick(150); await tick(150);
  assert.deepEqual(pastes, [], 'an attachment that cannot type yet drops what it is given');
  await r.update({ writable: true });
  await tick(150);
  assert.deepEqual(pastes, [], 'the screen, and what the app asked of pastes, arrive one check later');
  await tick(150);
  // This terminal's app never asked for bracketed paste, so a line break would send the first line.
  assert.deepEqual(pastes, ['Redraw these images. - art/a.png']);
  assert.equal(taken, true);
  await tick(600);
  assert.equal(pastes.length, 1, 'typed once');
  await act(async () => { void r.prompts.add('b', 'for another conversation'); });
  await tick(600);
  assert.equal(pastes.length, 1);
});

test('an app that asked for bracketed paste gets the text with its lines', async t => {
  t.after(() => { for (const name of ['DataTransfer', 'ClipboardEvent']) delete (globalThis as Record<string, unknown>)[name]; });
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const r = rig(); await r.render();
  // xterm as DSH's terminal keeps it: in a ref of the component above the element it opened in.
  const opened = document.createElement('div'), screen = document.createElement('div');
  screen.className = 'xterm'; opened.append(screen); r.host.append(opened);
  const handler = () => ({ dispose() {} });
  const xterm = { loadAddon() {}, element: screen, options: {}, modes: { mouseTrackingMode: 'none', bracketedPasteMode: true }, buffer: { active: { type: 'normal' } }, parser: { registerOscHandler: handler, registerCsiHandler: handler } };
  (opened as unknown as Record<string, unknown>).__reactFiber$test = { memoizedState: { memoizedState: { current: xterm }, next: null }, return: null };
  const pastes = terminalInput(screen);
  await act(async () => { void r.prompts.add('a', 'Redraw these images.\n\n- art/a.png\n- art/b.png'); });
  await tick(150); await tick(150);
  assert.deepEqual(pastes, ['Redraw these images.\n\n- art/a.png\n- art/b.png']);
});
