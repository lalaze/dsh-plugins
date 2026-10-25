import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../src/store.ts';
import { RemoteAgentsService } from '../src/service.ts';
import { createHandler } from '../src/http.ts';
import { FakeRemote } from '../test/fakes.ts';
import { ANTIGRAVITY_NOTICE } from '../src/antigravity.ts';

const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-preview-'));
const store = new Store(join(directory, 'state.json')); await store.open();
const remote = new FakeRemote();
remote.catalog[0].models[0].label = 'Remote model';
remote.catalog.push({ id: 'dsh', label: 'DSH', status: 'ready', models: [{ id: 'dsh-remote', label: 'DSH remote model' }], modes: [] });
remote.catalog.push({ id: 'antigravity', label: 'Antigravity', status: 'ready', notice: ANTIGRAVITY_NOTICE, models: [{ id: 'agy-remote', label: 'Antigravity remote model' }], modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }], defaultModeId: 'default' });
for (const [id, label] of [['grok', 'Grok'], ['codebuddy', 'CodeBuddy']]) remote.catalog.push({ id, label, status: 'ready', models: [{ id: `${id}-remote`, label: `${label} remote model`, thinkingOptions: [{ id: 'high', label: 'High' }], defaultThinkingOptionId: 'high' }], modes: [] });
remote.onCreate = (agent, task) => {
  agent.status = 'running'; agent.activeTurn = { turnId: `turn-${task.id}`, startedAt: new Date().toISOString() };
  agent.pendingPermissions = [{ id: `approval-${task.id}`, name: 'Bash', kind: 'tool', title: 'Run project checks', detail: { command: 'pnpm test', cwd: task.cwd }, actions: [{ id: 'native-allow-once', label: '允许运行一次', behavior: 'allow' }, { id: 'native-deny', label: '拒绝运行', behavior: 'deny' }] }];
  remote.append(agent.id, { type: 'reasoning', text: '正在检查远程项目，并准备运行测试。' });
};
const factory = host => {
  const backend = remote.backend(host), respond = backend.respond;
  backend.respond = async (id, requestId, answer, input) => {
    await respond(id, requestId, answer, input);
    const agent = remote.agents.get(id);
    if (answer.behavior === 'deny') { agent.status = 'idle'; agent.activeTurn = null; return; }
    if (requestId.startsWith('approval-')) {
      agent.pendingPermissions = [{ id: `question-${id}`, name: 'AskUserQuestion', kind: 'question', title: 'Choose verification', input: { questions: [{ header: 'Checks', question: 'Which checks should run?', multiSelect: true, allowOther: true, options: [{ label: 'Unit tests', description: 'Run the project test suite' }, { label: 'Type check' }] }] } }];
    } else {
      remote.append(id, { type: 'tool_call', callId: 'checks-1', name: 'Bash', status: 'running', detail: { command: 'pnpm test' } });
      remote.append(id, { type: 'tool_call', callId: 'checks-1', name: 'Bash', status: 'completed', detail: { command: 'pnpm test', output: 'All tests passed', exitCode: 0 } });
      remote.append(id, { type: 'assistant_message', text: '已完成远程项目修改。' });
      remote.append(id, { type: 'assistant_message', text: '\n测试全部通过。' });
      agent.status = 'idle'; agent.activeTurn = null;
    }
  };
  return backend;
};
const sshConfig = { hosts: ['build-box', 'code', 'code-233', 'code-home', 'code-home-233', 'docker', 'macmini', 'mihomo', 'pve', 'ubuntu-dev', 'unraid', 'window'].map(alias => ({ alias, connection: `ssh://${alias}` })), warnings: [] };
const service = new RemoteAgentsService(store, factory, async () => sshConfig), handler = createHandler(service);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await build({ absWorkingDir: root, entryPoints: ['test/ui/app.fixture.tsx'], bundle: true, write: false, outfile: 'preview.js', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, platform: 'browser', format: 'esm', target: 'es2022' });
const css = output.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
const script = output.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>远程任务 · 演示环境</title><style>${css}</style></head><body><script type="module">${script}</script></body></html>`;
let failReads = false;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url === '/__fixture') {
      if (request.method === 'POST') {
        const input = JSON.parse(body.toString());
        if (input.failReads !== undefined) failReads = input.failReads === true;
        if (input.sshConfig) { sshConfig.hosts = input.sshConfig.hosts; sshConfig.warnings = input.sshConfig.warnings ?? []; }
        if (input.resumable === false) for (const agent of remote.agents.values()) agent.resumable = false;
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ creates: remote.creates, stops: remote.stops, sends: remote.sends, disconnects: remote.disconnects, answers: remote.answers, state: service.snapshot() })); return;
    }
    if (request.url?.startsWith('/dsh-oh-my-claude')) {
      if (request.url.includes('/events')) { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); response.write(': fixture stream\n\n'); return; }
      const data = request.url.includes('/claude-update') ? { host: '', label: 'Preview host', installed: null, channel: 'latest', busy: false, auto: false, log: [] }
        : request.url.includes('/tool-mode') ? { mode: 'inline', rows: { ok: true, reason: '' } }
        : request.url.endsWith('/boxes') || request.url.endsWith('/ssh-boxes') ? { boxes: [] }
        : request.url.includes('sessions') ? { sessions: [] }
        : request.url.includes('remote-workspaces') ? { workspaces: [] }
        : request.url.includes('changelog') ? { text: 'Fixture changelog' }
        : request.url.includes('plugin-update') ? { current: '0.3.0', latest: '0.3.0' }
        : {};
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); return;
    }
    if (request.url === '/api/remote-agents') {
      if (failReads && request.method === 'POST' && JSON.parse(body.toString()).action === 'task') { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '模拟连接中断' })); return; }
      const result = await handler(new Request(`http://preview.test${request.url}`, { method: request.method, headers: request.headers, ...(request.method === 'POST' ? { body } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.DSH_REMOTE_PREVIEW_PORT ?? 4187), '0.0.0.0', resolve); });
console.log(`Remote agents preview: http://100.96.195.115:${server.address().port}/`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await service.close(); await rm(directory, { recursive: true, force: true });
}
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
