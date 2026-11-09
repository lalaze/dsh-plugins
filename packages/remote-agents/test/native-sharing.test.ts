import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSharingStatus, setNativeSharing } from '../src/chat/native-sharing.js';
import { NativeSharingSettings } from '../src/client/settings/native-sharing.js';
import { createHandler } from '../src/http.js';
import { fixture } from './fakes.js';

const request = (body: object) => new Request('http://dsh.test/api/remote-agents', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body),
});

test('ordinary sharing explicitly reports unavailable and cannot be enabled', () => {
  assert.deepEqual(nativeSharingStatus(), setNativeSharing(false));
  assert.equal(nativeSharingStatus().enabled, false);
  assert.equal(nativeSharingStatus().available, false);
  assert.throws(() => setNativeSharing(true), error => error instanceof Error && /native host integration/.test(error.message) && 'status' in error && error.status === 501);
  for (const enabled of [undefined, null, 'true', 'false', 0, 1, {}]) assert.throws(() => setNativeSharing(enabled), /must be a boolean/);
  const status = nativeSharingStatus();
  Object.assign(status, { enabled: true, available: true });
  assert.equal(nativeSharingStatus().enabled, false, 'a caller cannot mutate future capability results');
});

test('native sharing entry stays off and explains remote-workspace scope', () => {
  const html = renderToStaticMarkup(React.createElement(NativeSharingSettings));
  assert.match(html, /<fieldset[^>]*disabled/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /Ordinary DSH conversations/);
  assert.match(html, /private chats are never scanned/);
});

test('server rejects concurrent native enrollments without changing CLI state or sessions', async t => {
  const { service, store, remote } = await fixture(t), handler = createHandler(service);
  const before = store.snapshot();
  const status = await handler(request({ action: 'nativeSharing' }));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), nativeSharingStatus());
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => handler(request({
    action: 'setNativeSharing', enabled: true, sessionId: 'private-session', expectedVersion: i,
    // Must never be interpreted as a native log or a local filename.
    attachments: [{ path: '../../private', data: 'not-an-attachment' }],
  }))));
  for (const attempt of attempts) {
    assert.equal(attempt.status, 501);
    assert.match((await attempt.json()).error, /No ordinary conversations are shared/);
  }
  assert.equal((await handler(request({ action: 'setNativeSharing', enabled: false }))).status, 200);
  assert.equal((await handler(request({ action: 'setNativeSharing', enabled: 'false' }))).status, 400);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(remote.creates, 0);
  assert.equal(remote.sends, 0);
});

test('native capability endpoint keeps request authentication checks', async t => {
  const { service } = await fixture(t);
  const response = await createHandler(service)(new Request('http://dsh.test/api/remote-agents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setNativeSharing', enabled: true }),
  }));
  assert.equal(response.status, 403);
});

test('installed native host: cold restore continues, but live replacement lacks the owner capability', {
  skip: !process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME to an installed runtime node_modules directory; no profile is loaded',
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/native-sharing-host.mjs', import.meta.url)), process.env.DSH_NATIVE_TEST_RUNTIME!,
  ], { timeout: 30_000, maxBuffer: 256 * 1024, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR } });
  assert.deepEqual(JSON.parse(stdout.trim()), {
    ordinaryHooks: true, coldSeedContinues: true, receiverSystemRebuilt: true,
    idleWriterExclusive: true, lookupHasNoDisposer: true, liveSeedReplacementRejected: true, appendPublishes: true,
  });
});

test('installed native host: production sharing imports compressed tool history and continues on both instances', {
  skip: !process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME to audit real installed DSH components without a profile',
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('./fixtures/native-sharing-flow.mjs', import.meta.url)), process.env.DSH_NATIVE_TEST_RUNTIME!,
  ], { timeout: 30_000, maxBuffer: 256 * 1024, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR } });
  assert.deepEqual(JSON.parse(stdout.trim()), { twoInstancesContinue: true, compactedToolHistory: true, fileIntegrity: true,
    readOnlyReceiver: true, importNoExecution: true, rebuiltRuntime: true, roundTripLinkedCopies: true, rejectedInputRetained: true, auxiliaryAllowed: true,
    realWorkspaceController: true, realPermissionPresets: true, restartTailRefused: true, closedNeverPublished: true, ordinaryToolsAvailable: true, branchMetadata: true,
    committedReleaseRecovered: true, cancellationReshare: true, closedForkReshare: true });
});
