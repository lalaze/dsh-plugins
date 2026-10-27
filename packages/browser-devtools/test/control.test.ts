import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlDevTools, type Panel, type State } from '../src/client/control.js';

class Guest extends EventTarget {
  url = 'https://example.com/';
  /** Development DSH builds allow guest DevTools; packaged builds turn them off. */
  devTools = false;
  nativeOpened = false;
  getURL() { return this.url; }
  executeJavaScript(): Promise<unknown> { return Promise.resolve(null); }
  openDevTools() { if (this.devTools) { this.nativeOpened = true; this.dispatchEvent(new Event('devtools-opened')); } }
  closeDevTools() { this.nativeOpened = false; this.dispatchEvent(new Event('devtools-closed')); }
  isDevToolsOpened() { return this.nativeOpened; }
}
class FakePanel implements Panel {
  opened = false;
  opens = 0;
  failure: Error | undefined;
  async open() { this.opens++; if (this.failure) throw this.failure; this.opened = true; }
  close() { this.opened = false; }
}
const setup = () => {
  const guest = new Guest(), panel = new FakePanel();
  let state: State = { ready: false, opened: false, native: false, busy: false };
  const control = controlDevTools(guest, panel, value => { state = value; }, 5);
  return { guest, panel, control, state: () => state };
};

test('packaged DSH: the button docks the debugger panel and closes it again', async () => {
  const { panel, control, state } = setup();
  await control.toggle();
  assert.equal(panel.opens, 1); assert.equal(state().opened, true); assert.equal(state().native, false); assert.equal(state().busy, false);
  await control.toggle();
  assert.equal(panel.opened, false); assert.equal(state().opened, false);
  control.dispose();
});

test('development DSH: Chromium DevTools open first and the panel stays closed', async () => {
  const { guest, panel, control, state } = setup();
  guest.devTools = true;
  await control.toggle();
  assert.equal(guest.nativeOpened, true); assert.equal(panel.opens, 0); assert.equal(state().native, true);
  await control.toggle();
  assert.equal(guest.nativeOpened, false); assert.equal(state().native, false); assert.equal(panel.opens, 0);
  control.dispose();
});

test('pages that are not web pages cannot be inspected until they navigate', async () => {
  const { guest, panel, control, state } = setup();
  guest.url = 'about:blank#lease'; guest.dispatchEvent(new Event('did-navigate'));
  await control.toggle();
  assert.equal(panel.opens, 0); assert.equal(state().ready, false);
  guest.url = 'https://example.com/'; guest.dispatchEvent(new Event('dom-ready'));
  assert.equal(state().ready, true);
  await control.toggle(); assert.equal(state().opened, true);
  control.dispose();
});

test('a browser view the panel cannot dock in is reported, other failures can be retried', async () => {
  const { panel, control, state } = setup();
  panel.failure = new Error('layout');
  await control.toggle();
  assert.equal(state().error, 'unavailable'); assert.equal(state().opened, false); assert.equal(state().busy, false);
  panel.failure = new Error('boom');
  await control.toggle(); assert.equal(state().error, 'failed');
  control.dismiss(); assert.equal(state().error, undefined);
  panel.failure = undefined;
  await control.toggle(); assert.equal(state().opened, true); assert.equal(state().error, undefined);
  control.dispose();
});

test('disposal stops reacting to guest events', () => {
  const { guest, control } = setup();
  const history: State[] = [];
  const watched = controlDevTools(guest, new FakePanel(), value => history.push(value));
  watched.dispose(); const length = history.length;
  guest.dispatchEvent(new Event('dom-ready'));
  assert.equal(history.length, length);
  control.dispose();
});
