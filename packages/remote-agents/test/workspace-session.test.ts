import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHandler } from '../src/http.js';
import { ensureAnchor } from '../src/remote-workspaces.js';
import { RemoteAgentsService } from '../src/service.js';
import { WorkspaceAccess } from '../src/workspace-access.js';
import { fixture } from './fakes.js';

const post = (handler: ReturnType<typeof createHandler>, body: Record<string, unknown>) => handler(new Request('http://dsh.test/api/remote-agents', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body),
}));

test('new workspace sessions execute in the verified remote directory and retries create once', async t => {
  const { directory, store, service, remote, hostId, request } = await fixture(t);
  const endpoint = { host: 'build-box', username: 'builder', port: 22 };
  const anchor = await ensureAnchor(directory, endpoint, '/srv/app');
  await mkdir(join(anchor, 'src'));
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, endpoint: async () => endpoint });
  const handler = createHandler(service, undefined, async sessionId => {
    assert.equal(sessionId, 'current-session');
    return access.resolve(join(anchor, 'src'));
  });
  const body = { action: 'createWorkspaceSession', sessionId: 'current-session', agent: request({ cwd: '/srv/app/src' }) };
  const response = await post(handler, body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(remote.created?.cwd, '/srv/app/src');
  assert.equal(remote.created?.hostId, hostId);
  assert.equal((await post(handler, body)).status, 200);
  assert.equal(remote.creates, 1);
  assert.equal((await post(handler, { ...body, agent: request({ cwd: anchor }) })).status, 409, 'a local anchor is never executed remotely');
  assert.equal(remote.creates, 1);
});

test('workspace session creation refuses another host, changed directories and local or missing workspaces', async t => {
  const { service, remote, hostId, request } = await fixture(t);
  const otherId = (await service.addHost({ label: 'Other', connection: 'ssh://other-box' })).hosts.at(-1)!.id;
  let placement: { hostIds: string[]; cwd?: string } = { hostIds: [hostId], cwd: '/srv/app' };
  const handler = createHandler(service, undefined, async () => placement);
  const body = { action: 'createWorkspaceSession', sessionId: 'current-session', agent: request({ cwd: '/srv/app' }) };
  assert.equal((await post(handler, { ...body, agent: request({ hostId: otherId, cwd: '/srv/app' }) })).status, 409);
  placement = { hostIds: [hostId], cwd: '/srv/changed' };
  assert.equal((await post(handler, body)).status, 409);
  placement = { hostIds: [] };
  assert.equal((await post(handler, body)).status, 409);
  assert.equal((await post(handler, { ...body, sessionId: undefined })).status, 400);
  assert.equal((await post(createHandler(service), body)).status, 501);
  assert.equal(remote.creates, 0);
  // Explicit remote-directory callers (including delegation) retain their existing contract.
  assert.equal((await post(createHandler(service), { action: 'create', agent: request() })).status, 200);
});

test('a workspace switch during CLI discovery is rejected before saving or starting an agent', async t => {
  const { service: original, store, remote, hostId, request } = await fixture(t);
  await original.close();
  let cwd = '/srv/app';
  const service = new RemoteAgentsService(store, host => {
    const backend = remote.backend(host);
    return { ...backend, providers: async (...args) => { const providers = await backend.providers(...args); cwd = '/srv/other'; return providers; } };
  });
  t.after(() => service.close());
  const handler = createHandler(service, undefined, async () => ({ hostIds: [hostId], cwd }));
  const response = await post(handler, { action: 'createWorkspaceSession', sessionId: 'current-session', agent: request({ cwd }) });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(remote.creates, 0);
  assert.equal(store.snapshot().tasks.length, 0);
});
