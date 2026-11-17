import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { MachineInfo } from '../src/model.js';
import { createLinkService } from '../src/service.js';

test('other plugins list the machines and GET from an online one through its listener', async () => {
  const seen: { url?: string; hop?: string; accept?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, hop: req.headers['x-dsh-link-hop'] as string | undefined, accept: req.headers.accept });
    res.writeHead(req.url?.startsWith('/api/usage-stats') ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const machines: MachineInfo[] = [
      { id: 'm1', name: 'code', os: 'linux', url, source: 'tailnet', state: 'online' },
      { id: 'm2', name: 'air', os: 'macOS', url, source: 'tailnet', state: 'offline' },
    ];
    const service = createLinkService(() => ({ id: 'me', name: 'mac-mini' }), { list: () => machines, get: id => machines.find(machine => machine.id === id) });
    assert.equal(service.version, 1);
    assert.deepEqual(service.self(), { id: 'me', name: 'mac-mini' });
    assert.deepEqual(service.machines().map(machine => machine.name), ['code', 'air']);
    assert.deepEqual(await service.get('m1', '/api/usage-stats?tz=480'), { status: 200, text: '{"ok":true}' });
    assert.deepEqual(seen, [{ url: '/api/usage-stats?tz=480', hop: undefined, accept: 'application/json' }]);
    await assert.rejects(service.get('m2', '/api/usage-stats'), /air is offline/);
    await assert.rejects(service.get('zz', '/api/usage-stats'), /not known/);
    await assert.rejects(service.get('m1', '//evil.example/x'), /absolute path/);
    assert.equal(seen.length, 1);
  } finally { server.close(); }
});
