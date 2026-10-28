import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { acpServers, mcpServerOf, Sharing, sharedArguments, type SharedTool, type SkillSummary } from '../src/sharing.js';
import type { HostConfig, Task } from '../src/domain.js';
import type { SshTransport } from '../src/ssh.js';

/** Runs "remote" commands locally under a private HOME, so the bridge script really installs and syncs. */
function localTransport(home: string): SshTransport {
  const run = (script: string, input?: Buffer) => new Promise<Buffer>((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = '';
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err || `exit ${code}`)));
    child.stdin.end(input);
  });
  return {
    exec: async script => (await run(script)).toString('utf8'),
    start: () => { throw new Error('unused'); },
    transfer: async (script, options) => { const chunks: Buffer[] = []; for await (const chunk of options.input ?? []) chunks.push(Buffer.from(chunk)); return run(script, Buffer.concat(chunks)); },
  };
}
/** Stands in for `ssh -R <socket>:127.0.0.1:<port>`: a local Unix socket piped to DSH's bridge port. */
function fakeForward(launched: string[][]) {
  return (args: string[]) => {
    launched.push(args);
    const spec = args[args.indexOf('-R') + 1], portAt = spec.lastIndexOf(':'), port = Number(spec.slice(portAt + 1)), socket = spec.slice(0, spec.lastIndexOf(':', portAt - 1));
    const child = new EventEmitter() as ChildProcess & EventEmitter, stderr = new PassThrough(), open = new Set<Socket>();
    Object.assign(child, { stderr, kill: () => { server.close(); for (const s of open) s.destroy(); child.emit('close', 0); return true; } });
    const server = createServer(client => {
      const upstream = connect(port, '127.0.0.1'); open.add(client); open.add(upstream);
      client.pipe(upstream).pipe(client); client.on('error', () => {}); upstream.on('error', () => client.destroy());
    }).listen(socket, () => stderr.write(`debug1: remote forward success for: listen ${socket}, connect 127.0.0.1:${port}\n`));
    return child;
  };
}
/** A newline-delimited JSON-RPC client for one stdio MCP server. */
function mcp(t: TestContext, command: string, args: string[], home: string) {
  const child = spawn(command, args, { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  let id = 0; const pending = new Map<number, (message: any) => void>(), notifications: string[] = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) pending.get(message.id)?.(message); else notifications.push(message.method);
  });
  return {
    notifications,
    request(method: string, params: Record<string, unknown> = {}) {
      const key = ++id;
      return new Promise<any>(resolve => { pending.set(key, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`); });
    },
  };
}
async function until(check: () => Promise<boolean> | boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await check()) return;
  assert.fail('condition not reached');
}
const exists = (path: string) => access(path).then(() => true, () => false);

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ra-share-')), home = join(root, 'h'), skillsDir = join(root, 'skills');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(home); await mkdir(join(skillsDir, 'review', 'scripts'), { recursive: true });
  await writeFile(join(skillsDir, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nRun scripts/check.sh first.\n');
  await writeFile(join(skillsDir, 'review', 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n'); await chmod(join(skillsDir, 'review', 'scripts', 'check.sh'), 0o755);
  await writeFile(join(skillsDir, 'notes.md'), '---\nname: notes\ndescription: Take notes\n---\nWrite notes.\n');
  const store = new Store(join(root, 'state.json')); await store.open();
  const host: HostConfig = { id: 'host-1', label: 'build', connection: 'ssh://dev@build', serverId: 'server-1' } as HostConfig;
  const task = (id: string, extra: Partial<Task> = {}) => ({ id, hostId: host.id, cwd: '/srv/app', provider: 'codex', model: 'm', prompt: 'p', serverId: 'server-1', title: 't', createdAt: '', state: 'ready', ...extra }) as Task;
  await store.update(state => { state.hosts.push(host); state.tasks.push(task('chat-task', { chat: { sessionId: 'session-1', route: 'r' } }), task('panel-task')); });
  const calls: { name: string; arguments: string; agent: unknown }[] = [];
  const tools: SharedTool[] = [
    { name: 'mcp__github__create_issue', description: 'Create an issue', parameters: { type: 'object', properties: { title: { type: 'string' } } } },
    { name: 'mcp__github__search', description: 'Search', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__web__fetch', description: 'Fetch', parameters: { type: 'object', properties: {} } },
    { name: 'read', description: 'DSH read tool' },
  ];
  const summaries: SkillSummary[] = [
    { name: 'review', description: 'Review a change', path: join(skillsDir, 'review', 'SKILL.md'), source: 'user-dsh', invocation: { modelInvocable: true } },
    { name: 'notes', description: 'Take notes', path: join(skillsDir, 'notes.md'), source: 'user-agents', invocation: { modelInvocable: true } },
    { name: 'embedded', description: 'From a plugin', source: 'runtime', invocation: { modelInvocable: true } },
    { name: 'project-only', description: 'Local anchor project', path: join(skillsDir, 'notes.md'), source: 'project-dsh', invocation: { modelInvocable: true } },
    { name: 'human-only', description: 'User command', path: join(skillsDir, 'notes.md'), source: 'user-dsh', invocation: { modelInvocable: false } },
  ];
  const launched: string[][] = [], agent = { id: 'session-1' };
  const sharing = new Sharing(store, fakeForward(launched), () => {});
  t.after(() => sharing.close());
  Object.assign(sharing.host, {
    tools: { definitions: () => tools, execute: async (input: any) => {
      calls.push({ name: input.calls[0].name, arguments: input.calls[0].arguments, agent: input.agent });
      return { results: [{ result: { isError: false, value: { content: [{ type: 'text', text: 'created #1' }] }, content: [{ type: 'text', text: '{}' }] } }] };
    } },
    skills: { list: async () => summaries, get: async (name: string) => name === 'embedded' ? { content: 'Embedded body.' } : undefined },
    agent: (id: string) => id === 'session-1' ? agent : undefined,
  });
  return { root, home, store, host, sharing, calls, launched, agent, transport: localTransport(home), task: (id: string) => store.task(t => t.id === id)! };
}

test('MCP tool names map to their DSH server', () => {
  assert.equal(mcpServerOf('mcp__github__create_issue'), 'github');
  assert.equal(mcpServerOf('mcp__my-server__a__b'), 'my-server');
  assert.equal(mcpServerOf('read'), undefined);
});

test('each CLI receives the shares in its own launch form; the saved argv is untouched', () => {
  const shared = { pluginDir: '/h/.dsh-remote-agents/shared', servers: [{ name: 'dsh-github', command: '/usr/bin/node', args: ['/h/bridge.mjs', 'proxy', '/h/t.json', 'github'] }] };
  const claude = sharedArguments('claude', ['claude', '-p'], shared);
  assert.deepEqual(claude.slice(0, 4), ['claude', '-p', '--plugin-dir', '/h/.dsh-remote-agents/shared']);
  assert.deepEqual(JSON.parse(claude[claude.indexOf('--mcp-config') + 1]), { mcpServers: { 'dsh-github': { type: 'stdio', command: '/usr/bin/node', args: shared.servers[0].args } } });
  assert.deepEqual(claude.slice(-2), ['--allowedTools', 'mcp__dsh-github'], 'DSH is the only approval gate for proxied tools');
  const codex = sharedArguments('codex', ['codex', 'app-server'], shared);
  assert.deepEqual(codex, ['codex', '-c', 'mcp_servers.dsh-github.command="/usr/bin/node"', '-c', `mcp_servers.dsh-github.args=${JSON.stringify(shared.servers[0].args)}`,
    '-c', 'mcp_servers.dsh-github.default_tools_approval_mode="approve"', 'app-server'], 'config overrides precede the subcommand');
  assert.deepEqual(sharedArguments('acp', ['dsh', '--profile', 'acp'], shared), ['dsh', '--profile', 'acp']);
  assert.deepEqual(acpServers(shared), [{ name: 'dsh-github', command: '/usr/bin/node', args: shared.servers[0].args, env: [] }]);
  assert.deepEqual(sharedArguments('claude', ['claude'], { servers: [] }), ['claude']);
});

test('skills are copied once and shared natively with Claude and as load_skill elsewhere; MCP stays off until enabled', async t => {
  const { home, sharing, transport, host, task } = await setup(t);
  const codex = await sharing.prepare(host, transport, task('chat-task'), 'codex');
  const shared = join(home, '.dsh-remote-agents', 'shared');
  assert.deepEqual(codex.servers.map(s => s.name), ['dsh'], 'no MCP server is shared by default');
  assert.equal(codex.pluginDir, undefined);
  assert.match(await readFile(join(shared, 'skills', 'review', 'scripts', 'check.sh'), 'utf8'), /echo ok/);
  assert.ok(((await stat(join(shared, 'skills', 'review', 'scripts', 'check.sh'))).mode & 0o100) !== 0, 'scripts stay executable');
  assert.match(await readFile(join(shared, 'skills', 'notes', 'SKILL.md'), 'utf8'), /Write notes/, 'a flat skill becomes a bundle');
  assert.match(await readFile(join(shared, 'skills', 'embedded', 'SKILL.md'), 'utf8'), /^---\nname: embedded\ndescription: "From a plugin"\n---\n\nEmbedded body\./);
  assert.ok(!await exists(join(shared, 'skills', 'project-only')) && !await exists(join(shared, 'skills', 'human-only')), 'project and user-only skills stay in DSH');
  assert.deepEqual(JSON.parse(await readFile(join(shared, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'dsh');
  const claude = await sharing.prepare(host, transport, task('chat-task'), 'claude');
  assert.equal(claude.pluginDir, shared); assert.deepEqual(claude.servers, []);
  assert.deepEqual(await sharing.prepare(host, transport, task('chat-task'), 'antigravity'), { servers: [] });

  const skills = mcp(t, codex.servers[0].command, codex.servers[0].args, home);
  assert.equal((await skills.request('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'dsh');
  const [load] = (await skills.request('tools/list')).result.tools;
  assert.equal(load.name, 'load_skill'); assert.deepEqual(load.inputSchema.properties.name.enum, ['review', 'notes', 'embedded']);
  assert.match(load.description, /- review: Review a change/);
  const loaded = (await skills.request('tools/call', { name: 'load_skill', arguments: { name: 'review' } })).result;
  assert.match(loaded.content[0].text, new RegExp(`files are in ${join(shared, 'skills', 'review')}[\\s\\S]*Run scripts/check.sh first`));
  assert.equal((await skills.request('tools/call', { name: 'load_skill', arguments: { name: 'missing' } })).result.isError, true);

  await sharing.set('skill', 'notes', false);
  await sharing.prepare(host, transport, task('chat-task'), 'codex');
  assert.ok(!await exists(join(shared, 'skills', 'notes')), 'an unshared skill is removed from the host');
  await until(() => skills.notifications.includes('notifications/tools/list_changed'));
  assert.deepEqual((await skills.request('tools/list')).result.tools[0].inputSchema.properties.name.enum, ['review', 'embedded']);
  assert.equal((await sharing.catalog()).skills.find(s => s.name === 'notes')?.shared, false);
});

test('a shared MCP server runs in DSH with the owning conversation, through one reverse forward per host', async t => {
  const { home, sharing, transport, host, task, calls, launched, agent } = await setup(t);
  await sharing.set('mcp', 'github', true);
  assert.deepEqual((await sharing.catalog()).mcp, [{ name: 'github', tools: 2, shared: true }, { name: 'web', tools: 1, shared: false }]);
  assert.deepEqual((await sharing.prepare(host, transport, task('panel-task'), 'codex')).servers.map(s => s.name), ['dsh'], 'a CLI without a DSH conversation gets no proxies');
  const launch = await sharing.prepare(host, transport, task('chat-task'), 'acp');
  const proxy = launch.servers.find(s => s.name === 'dsh-github')!;
  assert.ok(proxy.command.startsWith('/'), 'ACP requires an absolute command');
  await until(() => exists(join(home, '.dsh-remote-agents', 'bridge', 'current')));
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].slice(-2), ['--', 'dev@build']);

  const client = mcp(t, proxy.command, proxy.args, home);
  assert.equal((await client.request('initialize', { protocolVersion: '2025-11-25' })).result.protocolVersion, '2025-11-25');
  assert.deepEqual((await client.request('tools/list')).result.tools.map((tool: { name: string }) => tool.name), ['create_issue', 'search']);
  const result = (await client.request('tools/call', { name: 'create_issue', arguments: { title: 'Bug' } })).result;
  assert.deepEqual(result, { content: [{ type: 'text', text: 'created #1' }] });
  assert.deepEqual(calls, [{ name: 'mcp__github__create_issue', arguments: '{"title":"Bug"}', agent }]);

  await sharing.set('mcp', 'github', false);
  await until(() => client.notifications.includes('notifications/tools/list_changed'));
  assert.deepEqual((await client.request('tools/list')).result.tools, []);
  assert.match((await client.request('tools/call', { name: 'create_issue', arguments: {} })).result.content[0].text, /no longer shared/);
  await sharing.set('mcp', 'github', true);
  await until(() => client.notifications.filter(n => n === 'notifications/tools/list_changed').length === 2);
  assert.equal((await client.request('tools/list')).result.tools.length, 2);
  await sharing.prepare(host, transport, task('chat-task'), 'codex');
  assert.equal(launched.length, 1, 'the forward is reused');

  await sharing.close();
  const offline = (await client.request('tools/call', { name: 'create_issue', arguments: {} })).result;
  assert.equal(offline.isError, true); assert.match(offline.content[0].text, /DSH could not run this tool/);
  assert.deepEqual((await client.request('tools/list')).result.tools.map((tool: { name: string }) => tool.name), ['create_issue', 'search'], 'the last tools are listed while DSH is away');
});

test('the bridge refuses a connection without the task token', async t => {
  const { sharing } = await setup(t);
  const port = await (sharing as unknown as { listen(): Promise<number> }).listen();
  const socket = createConnection(port, '127.0.0.1'); t.after(() => { socket.destroy(); });
  socket.write(`${JSON.stringify({ op: 'hello', task: 'chat-task', token: '0'.repeat(64), server: 'github' })}\n`);
  const [line] = await once(createInterface({ input: socket }), 'line');
  assert.equal(JSON.parse(line).hello, 'refused');
});

test('saved sharing settings are validated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ra-share-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await writeFile(path, JSON.stringify({ version: 1, hosts: [], tasks: [], sharing: { mcp: { github: 'yes' } } }));
  await assert.rejects(new Store(path).open(), /sharing settings/);
  await writeFile(path, JSON.stringify({ version: 1, hosts: [], tasks: [], sharing: { mcp: { github: true }, skills: { notes: false }, secret: 'a'.repeat(64) } }));
  const store = new Store(path); await store.open();
  assert.deepEqual(store.snapshot().sharing?.skills, { notes: false });
});
