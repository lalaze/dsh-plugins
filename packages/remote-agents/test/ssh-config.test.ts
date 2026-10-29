import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSshConfigHosts } from '../src/core/ssh-config.js';
import { createHandler } from '../src/http.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { Store } from '../src/core/store.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'remote-ssh-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.ssh/config'), systemConfig = join(home, 'system/ssh_config');
  const write = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  const read = () => readSshConfigHosts({ home, systemConfig, environment: { CONFIG_HOME: home } });
  return { home, config, systemConfig, write, read };
}

test('SSH config lists concrete aliases with quotes, comments, equals, exclusions and deduplication', async t => {
  const { config, write, read } = await fixture(t);
  await write(config, `
    # Host commented-out
    hOsT = "build-box" ubuntu-dev # Host trailing-comment
      HostName 100.64.80.78
      User ubuntu
      Port 2222
      IdentityFile ~/.ssh/private-key
      ProxyJump jump-host
    Host build-box *.example.com !excluded question? [ab] -invalid
    Host excluded !excluded
    Host worker !work*
    Host "malformed
  `);
  const result = await read();
  assert.deepEqual(result.hosts, [{ alias: 'build-box', connection: 'ssh://build-box' }, { alias: 'ubuntu-dev', connection: 'ssh://ubuntu-dev' }]);
  assert.deepEqual(result.warnings, []);
  assert(!JSON.stringify(result).includes('private-key'));
  assert(!JSON.stringify(result).includes('100.64.80.78'));
});

test('SSH config expands Includes, globs, environment and home paths with cycle protection', async t => {
  const { home, config, systemConfig, write, read } = await fixture(t);
  await write(config, `Include "conf.d/*.conf" "~/extra config" \${CONFIG_HOME}/env.conf
Host direct
`);
  await write(join(home, '.ssh/conf.d/first.conf'), 'Host included\nInclude nested.conf config\n');
  // Nested relative Includes stay relative to ~/.ssh, not the containing conf.d directory.
  await write(join(home, '.ssh/nested.conf'), 'Host nested\n');
  await write(join(home, '.ssh/conf.d/nested.conf'), 'Host other-included\n');
  await write(join(home, 'extra config'), 'Host home-include\n');
  await write(join(home, 'env.conf'), 'Host env-include\n');
  await symlink(config, join(home, '.ssh/conf.d/loop.conf'));
  await write(systemConfig, 'Include hosts/*.conf\nHost system-host\n');
  await write(join(home, 'system/hosts/fleet.conf'), 'Host system-included\n');
  assert.deepEqual((await read()).hosts.map(host => host.alias), ['direct', 'env-include', 'home-include', 'included', 'nested', 'other-included', 'system-host', 'system-included']);
  assert.deepEqual((await read()).warnings, []);
});

test('SSH config discovery never runs Match exec or connection commands and refresh sees edits', async t => {
  const { home, config, write, read } = await fixture(t), marker = join(home, 'executed');
  const original = `Host build-box\n  ProxyCommand touch ${marker}\nMatch exec "touch ${marker}"\nInclude absent-*.conf\n`;
  await write(config, original);
  assert.deepEqual((await read()).hosts.map(host => host.alias), ['build-box']);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(config, 'utf8'), original);
  await write(config, 'Host refreshed\n');
  assert.deepEqual((await read()).hosts, [{ alias: 'refreshed', connection: 'ssh://refreshed' }]);
});

test('missing SSH config permits manual connection entry; unreadable and oversized files report warnings', async t => {
  const { home, config, write, read } = await fixture(t);
  assert.deepEqual(await read(), { hosts: [], warnings: [] });
  await write(config, `Host visible\nInclude big.conf\n`);
  await write(join(home, '.ssh/big.conf'), '#'.repeat(1_048_577));
  assert.deepEqual((await read()).hosts, [{ alias: 'visible', connection: 'ssh://visible' }]);
  assert.match((await read()).warnings.join(' '), /too large/);
  await write(config, 'Host visible\nInclude ${NOT_DEFINED}/config\n');
  assert.match((await read()).warnings.join(' '), /context/);
  await symlink('loop-b', join(home, '.ssh/loop-a'));
  await symlink('loop-a', join(home, '.ssh/loop-b'));
  await write(config, 'Include loop-a\n');
  assert.match((await read()).warnings.join(' '), /Could not read SSH config \(ELOOP\)/);
});

test('SSH config enumeration bounds recursive includes and total host count', async t => {
  const { home, config, write, read } = await fixture(t);
  await write(config, 'Include depth-0\n');
  for (let i = 0; i < 20; i++) await write(join(home, '.ssh', `depth-${i}`), `Host depth-${i}\nInclude depth-${i + 1}\n`);
  assert.match((await read()).warnings.join(' '), /too large/);
  assert((await read()).hosts.length < 20);
  await write(config, `Host ${Array.from({ length: 600 }, (_, i) => `host-${i}`).join(' ')}\n`);
  assert.equal((await read()).hosts.length, 512);
  assert.match((await read()).warnings.join(' '), /too large/);
});

test('SSH config API uses server configuration and saving preserves the alias for OpenSSH resolution', async t => {
  const { home, config, write, read } = await fixture(t);
  await write(config, 'Host build-box\nHostName 100.64.80.78\nUser ubuntu\nPort 2222\nProxyJump bastion\n');
  const store = new Store(join(home, 'state.json')); await store.open();
  let backendCalls = 0;
  const service = new RemoteAgentsService(store, () => { backendCalls++; throw new Error('Simulated SSH failure'); }, read);
  t.after(() => service.close());
  const handler = createHandler(service);
  const post = (data: unknown, authorized = true) => handler(new Request('http://dsh.test/api/remote-agents', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'X-DSH-Remote-Agents': '1' } : {}) }, body: JSON.stringify(data),
  }));
  assert.equal((await post({ action: 'sshConfig' }, false)).status, 403);
  const response = await post({ action: 'sshConfig', path: '/some/client/supplied/path' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result, { hosts: [{ alias: 'build-box', connection: 'ssh://build-box' }], warnings: [] });
  assert.equal(backendCalls, 0);
  assert.deepEqual(await service.snapshot(), { hosts: [], agents: [] });
  assert.equal((await post({ action: 'addHost', host: { label: result.hosts[0].alias, connection: result.hosts[0].connection } })).status, 200);
  assert.equal((await service.snapshot()).hosts[0].connection, 'ssh://build-box');
  assert.equal(backendCalls, 1, 'saving the selected machine starts model discovery');
  assert.equal((await service.snapshot()).hosts[0].modelError, 'Simulated SSH failure');
});
