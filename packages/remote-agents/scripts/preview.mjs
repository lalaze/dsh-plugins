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
import { CHAT_PROVIDERS, RemoteCliAdapter } from '../src/native-chat.ts';
import { ChatProjects } from '../src/chat-projects.ts';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-preview-'));
const store = new Store(join(directory, 'state.json')); await store.open();
const remote = new FakeRemote();
remote.store = store;
remote.catalog[0].models[0].label = 'Remote model';
remote.catalog.push({ id: 'dsh', label: 'DSH', status: 'ready', models: [{ id: 'dsh-remote', label: 'DSH remote model' }], modes: [] });
remote.catalog.push({ id: 'antigravity', label: 'Antigravity', status: 'ready', notice: ANTIGRAVITY_NOTICE, models: [{ id: 'agy-remote', label: 'Antigravity remote model' }], modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }], defaultModeId: 'default' });
for (const [id, label] of [['grok', 'Grok'], ['codebuddy', 'CodeBuddy']]) remote.catalog.push({ id, label, status: 'ready', models: [{ id: `${id}-remote`, label: `${label} remote model`, thinkingOptions: [{ id: 'high', label: 'High' }], defaultThinkingOptionId: 'high' }], modes: [] });
const sshConfig = { hosts: ['build-box', 'code', 'code-233', 'code-home', 'code-home-233', 'docker', 'macmini', 'mihomo', 'pve', 'ubuntu-dev', 'unraid', 'window'].map(alias => ({ alias, connection: `ssh://${alias}` })), warnings: [] };
const timers = new Set();
let connectionError;
let workspaceHostIds = ['macmini'];
const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
remote.onCreate = agent => { remote.append(agent.id, { type: 'assistant_message', text: '远程会话已准备好，可以继续描述任务。' }); };
remote.onSend = (agent, text) => {
  agent.status = 'running'; remote.append(agent.id, { type: 'reasoning', text: '正在检查远程项目。' });
  later(() => { remote.append(agent.id, { type: 'assistant_message', text: '已完成：' }); }, 200);
  later(() => { remote.append(agent.id, { type: 'assistant_message', text }); agent.status = 'idle'; }, 500);
};
const service = new RemoteAgentsService(store, host => {
  const backend = remote.backend(host);
  return { ...backend, connect: async () => { if (connectionError) throw new Error(connectionError); return backend.connect(); }, respond: async (id, requestId, answer) => {
    await backend.respond(id, requestId, answer);
    const agent = remote.agents.get(id);
    if (!agent.pendingPermissions.length) { remote.append(id, { type: 'assistant_message', text: answer.behavior === 'allow' ? '审批已通过，检查完成。' : '已拒绝该操作。' }); agent.status = 'idle'; }
  } };
}, async () => sshConfig), handler = createHandler(service, undefined, async () => ({ hostIds: workspaceHostIds }));
const adapter = new RemoteCliAdapter(new ChatProjects(service), { agent: () => undefined, step: () => undefined });
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await build({ absWorkingDir: root, entryPoints: ['test/ui/app.fixture.tsx'], bundle: true, write: false, outfile: 'preview.js', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, platform: 'browser', format: 'esm', target: 'es2022' });
const css = output.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
const script = output.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>远程智能体 · 演示环境</title><style>${css}</style></head><body><script type="module">${script}</script></body></html>`;
let failReads = false;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url === '/__fixture') {
      if (request.method === 'POST') {
        const input = JSON.parse(body.toString());
        if (Array.isArray(input.workspaceHostIds)) workspaceHostIds = input.workspaceHostIds;
        if (input.failReads !== undefined) failReads = input.failReads === true;
        if (input.connectionError !== undefined) connectionError = input.connectionError || undefined;
        if (input.sshConfig) { sshConfig.hosts = input.sshConfig.hosts; sshConfig.warnings = input.sshConfig.warnings ?? []; }
        if (input.loseSend) remote.loseSend = true;
        if (input.seedUsage) {
          let [project] = new ChatProjects(service).hosts();
          if (!project) { await service.addHost({ label: 'macmini', connection: 'ssh://macmini' }, { discoverModels: true }); [project] = new ChatProjects(service).hosts(); }
          const route = 'macmini/codex/codex-model';
          const task = store.snapshot().tasks.find(t => t.chat?.sessionId === 'fixture-conversation')
            ?? await service.create({ id: randomUUID(), hostId: project.hostId, cwd: '/srv/macmini', provider: 'codex', model: 'remote-model', prompt: '用量演示' }, { chat: { sessionId: 'fixture-conversation', route } });
          remote.live(task.id).context = input.seedUsage.context;
          remote.accountUsage = input.seedUsage.account ?? null;
        }
        if (input.seedSessions) {
          let project = new ChatProjects(service).hosts()[0];
          if (!project) {
            await service.addHost({ label: 'build-box', connection: 'ssh://build-box' }, { discoverModels: true });
            [project] = new ChatProjects(service).hosts();
          }
          const request = title => ({ id: randomUUID(), hostId: project.hostId, cwd: '/srv/main-chat', provider: 'codex', model: 'remote-model', prompt: title });
          const history = await service.create(request('整理项目测试'), { title: '整理项目测试' });
          const live = remote.live(history.id);
          remote.append(live.id, { type: 'user_message', text: '最早的一条历史消息', clientMessageId: 'history-oldest' });
          for (let i = 0; i < 120; i++) remote.append(live.id, { type: 'tool_call', callId: `check-${i}`, name: `检查文件 ${i + 1}`, status: 'completed', detail: '检查通过' });
          remote.append(live.id, { type: 'assistant_message', text: '测试检查完成，等待下一步。' });
          const pending = await service.create(request('审查构建脚本'), { title: '审查构建脚本', origin: 'dsh' });
          remote.live(pending.id).status = 'running';
          remote.live(pending.id).pendingPermissions = [{ id: 'fixture-approval', name: 'Bash', kind: 'tool', title: '运行项目测试', detail: { command: 'pnpm test', cwd: project.cwd }, actions: [{ id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' }, { id: 'session', label: 'Allow for this session', behavior: 'allow', scope: 'session' }, { id: 'project', label: 'Always allow matching requests in this project', behavior: 'allow', scope: 'project' }, { id: 'deny', label: 'Deny', behavior: 'deny' }] }];
          await service.create(request('实现搜索功能'), { title: '实现搜索功能', chat: { sessionId: 'fixture-main-chat', route: `${project.id}/codex/remote-model` } });
        }
        if (input.seedDesign && !store.snapshot().tasks.some(t => t.title === '修复登录状态同步')) {
          const claude = remote.catalog.find(p => p.id === 'claude');
          Object.assign(claude, { status: 'ready', models: [{ id: 'claude-demo', label: 'Claude Code' }], modes: [{ id: 'inherit', label: 'Remote CLI settings' }, { id: 'auto', label: 'Auto · safety checks' }] });
          const dashboard = await service.addHost({ label: 'macmini', connection: 'ssh://macmini' }, { discoverModels: true });
          const hostId = dashboard.hosts.find(h => h.label === 'macmini').id;
          for (const [index, title] of ['修复登录状态同步', '检查构建脚本', '补全接口测试', '整理项目依赖', '搜索功能优化'].entries()) {
            const task = await service.create({ id: randomUUID(), hostId, cwd: index > 3 ? '/Volumes/data/code/zeGame2' : '/Volumes/data/code/dsh-plugins', provider: 'claude', model: 'claude-demo', prompt: title }, { title });
            const live = remote.live(task.id);
            const timestamp = new Date(Date.now() - index * 5 * 60_000).toISOString();
            await store.update(state => { state.tasks.find(t => t.id === task.id).updatedAt = timestamp; });
            if (index === 0) {
              remote.entries.set(live.id, []);
              remote.append(live.id, { type: 'user_message', text: '检查登录后状态没有更新的问题，并补充测试。' });
              remote.append(live.id, { type: 'assistant_message', text: '### 已找到原因\n\n登录状态未更新是由于前端在登录成功后未正确刷新用户信息，导致全局状态仍使用旧的会话数据。\n\n1. 登录接口已正确返回最新的用户信息，但未触发状态更新。\n2. 全局状态管理中缺少在登录成功后重新获取用户信息的逻辑。\n3. 已在 `src/auth/session.ts` 中添加登录成功后的状态刷新，并补充了相关测试。' });
              for (const name of ['src/auth/session.ts', 'src/auth/store.ts', 'test/auth/session.test.ts', 'test/auth/login.test.ts']) remote.append(live.id, { type: 'tool_call', name, callId: name, status: 'completed', detail: '检查通过' });
            }
          }
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ creates: remote.creates, stops: remote.stops, sends: remote.sends, interrupts: remote.interrupts, detaches: remote.detaches, forgets: remote.forgets, answers: remote.answers, modelGroups: (await Promise.all(CHAT_PROVIDERS.map(async id => ({ ...adapter.providerInfo(id), models: await adapter.listModels(id) })))).filter(group => group.models.length), state: await service.snapshot(), tasks: store.snapshot().tasks })); return;
    }
    if (request.url === '/api/remote-agents') {
      if (failReads && request.method === 'GET') { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '模拟连接中断' })); return; }
      const result = await handler(new Request(`http://preview.test${request.url}`, { method: request.method, headers: request.headers, ...(request.method === 'POST' ? { body } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.DSH_REMOTE_PREVIEW_PORT ?? 4187), '0.0.0.0', resolve); });
console.log(`Remote agents preview: http://100.96.195.115:${server.address().port}/ (local http://127.0.0.1:${server.address().port}/)`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await service.close(); await rm(directory, { recursive: true, force: true });
}
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
