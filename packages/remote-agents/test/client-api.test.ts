import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestId } from '../src/client/api.js';
import { identifier } from '../src/domain.js';

test('LAN HTTP clients can create unique valid request IDs without crypto.randomUUID', t => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  t.after(() => { if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor); else Reflect.deleteProperty(crypto, 'randomUUID'); });
  const first = requestId(), second = requestId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(identifier(first), first);
  assert.notEqual(first, second);
});
