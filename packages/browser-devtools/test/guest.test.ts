import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { guestScript } from '../src/client/guest.js';

test('guest debugger commands are self-contained and parse as page scripts', () => {
  const script = guestScript('open');
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /dsh-browser-devtools/);
  assert.match(script, /data-dsh-pick/);
  assert.match(script, /XMLHttpRequest/);
  assert.match(script, /originalFetch/);
  assert.match(guestScript('close'), /"close"\)$/);
  assert.match(guestScript('state'), /"state"\)$/);
});
