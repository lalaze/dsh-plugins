import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { controlDevTools, type State } from '../src/client/control.js';

class Guest extends EventTarget {
  url = 'https://example.com/';
  opened = false;
  blocked = false;
  fail = false;
  scripts: string[] = [];

  getURL() { return this.url; }
  executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    if (this.fail) return Promise.reject(new Error('destroyed'));
    if (code.endsWith('(\"state\",\"en\")')) return Promise.resolve({ opened: this.opened, available: true });
    if (this.blocked) return Promise.resolve({ opened: false, available: false });
    if (code.endsWith('(\"open\",\"en\")')) {
      this.opened = true;
      return Promise.resolve({ opened: true, available: true });
    }
    this.opened = false;
    return Promise.resolve({ opened: false, available: true });
  }
}

test('opens only the chosen guest, closes it, and reflects the in-page window', async () => {
  const first = new Guest(); const second = new Guest();
  let state: State = { ready: false, opened: false, busy: false };
  const control = controlDevTools(second, value => { state = value; });
  control.toggle(); await delay(0);
  assert.equal(first.scripts.length, 0);
  assert.equal(second.scripts.some(script => script.includes('"open"')), true);
  assert.equal(state.opened, true); assert.equal(state.busy, false);
  second.opened = false; second.dispatchEvent(new Event('did-stop-loading')); await delay(0);
  assert.equal(state.opened, false);
  control.toggle(); await delay(0);
  assert.equal(second.scripts.some(script => script.includes('"open"')), true);
  control.dispose();
});

test('waiting guests become available after navigation; inert pages cannot be inspected', async () => {
  const guest = new Guest(); guest.url = 'about:blank#lease';
  let state: State = { ready: false, opened: false, busy: false };
  const control = controlDevTools(guest, value => { state = value; });
  control.toggle(); assert.equal(guest.scripts.length, 0);
  guest.url = 'https://example.com/'; guest.dispatchEvent(new Event('dom-ready')); await delay(0);
  assert.equal(state.ready, true); control.toggle(); await delay(0); assert.equal(state.opened, true);
  guest.dispatchEvent(new Event('render-process-gone')); assert.equal(state.ready, false);
  control.dispose();
});

test('blocked packaged guests report failure, allow retry, and never claim an opened window', async () => {
  const guest = new Guest(); guest.blocked = true;
  let state: State = { ready: false, opened: false, busy: false };
  const control = controlDevTools(guest, value => { state = value; }, 20);
  control.toggle(); await delay(0);
  assert.equal(state.error, 'unavailable'); assert.equal(state.opened, false); assert.equal(state.busy, false);
  control.dismiss(); assert.equal(state.error, undefined);
  guest.blocked = false; control.toggle(); await delay(0);
  assert.equal(state.opened, true); assert.equal(state.error, undefined);
  control.dispose();
});

test('execution errors recover and disposal cancels polling and pending events', async () => {
  const guest = new Guest(); guest.fail = true;
  const history: State[] = [];
  const control = controlDevTools(guest, state => history.push(state), 10);
  control.toggle(); await delay(0); assert.equal(history.at(-1)!.error, 'failed');
  control.dispose(); const length = history.length;
  guest.dispatchEvent(new Event('dom-ready')); await delay(30); assert.equal(history.length, length);
});
