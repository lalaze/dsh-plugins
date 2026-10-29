import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, type ContentBlock, type FileBlock, type GenerateOptions, type ImageBlock, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { OpenSshTransport, type Child, type SshTransport, type WireMessage } from '../src/core/ssh.js';
import { SshBackend, CLI_PROVIDERS } from '../src/agents/backend.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { Store } from '../src/core/store.js';
import { ChatProjects } from '../src/chat/projects.js';
import { chatModelId, chatProviderId, CHAT_PROVIDERS, RemoteCliAdapter } from '../src/chat/native-chat.js';
import { attachmentDirectory, attachmentRelativePath, stageAttachments, type AttachmentAccess } from '../src/agents/attachments.js';
import type { Attachment } from '../src/core/domain.js';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo8AAAAASUVORK5CYII=', 'base64');
const file = Buffer.from([0, 255, 1, 10, 13, 128, 0, 2]);
const image: ImageBlock = { type: 'image', attachment: { attachmentId: `sha256-${digest(png)}` as ImageBlock['attachment']['attachmentId'], name: 'screen.png', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } };
const document: FileBlock = { type: 'file', attachment: { attachmentId: `sha256-${digest(file)}` as FileBlock['attachment']['attachmentId'], name: "报告 ' $(ignored).bin", bytes: file.length } };
const user = (content: ContentBlock[]) => createUserMessage({ source: { kind: 'user' }, content });
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

class AttachmentSsh implements SshTransport {
  uploads: { path: string; data: Buffer }[] = [];
  prompts: WireMessage[] = [];
  failUpload = false;
  constructor(readonly provider: string, readonly imageCapable = true) {}
  async exec(script: string) {
    if (script.includes('uname -n')) return 'machine\0builder\0machine-id\0';
    if (script === 'printf \'%s\' "$HOME"') return '/home/builder';
    return '/srv/canonical\0' + CLI_PROVIDERS.map(p => `${p.id}\0${p.id === this.provider ? `/usr/bin/${p.command}` : ''}\0`).join('');
  }
  async upload(_cwd: string, path: string, source: AsyncIterable<Uint8Array>, bytes: number, sha256: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.failUpload) throw new Error('Simulated upload interrupted');
    const chunks: Uint8Array[] = []; for await (const chunk of source) chunks.push(chunk);
    const data = Buffer.concat(chunks); assert.equal(data.length, bytes); assert.equal(digest(data), sha256);
    const saved = `/srv/canonical/${path}`; this.uploads.push({ path: saved, data }); return saved;
  }
  start(): Child {
    let stopped = false;
    const readers: Array<(data: Buffer) => void> = [], exits: Array<(error: Error) => void> = [];
    const emit = (value: WireMessage) => { for (const read of readers) read(Buffer.from(JSON.stringify(value) + '\n')); };
    const reply = (m: WireMessage, result: unknown) => emit({ jsonrpc: '2.0', id: m.id, result });
    return {
      write: line => { const m = JSON.parse(line); queueMicrotask(() => {
        if (stopped) return;
        if (m.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request.subtype === 'list_models' ? { models: [{ value: 'model', displayName: 'Claude' }] } : {} } });
        if (m.method === 'initialize') reply(m, this.provider === 'codex' ? {} : { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: this.imageCapable } } });
        if (m.method === 'model/list') reply(m, { data: [{ id: 'model', model: 'model', displayName: 'Codex', inputModalities: this.imageCapable ? ['text', 'image'] : ['text'] }] });
        if (m.method === 'thread/start' || m.method === 'thread/resume') reply(m, { thread: { id: 'thread-attachments' } });
        if (m.method === 'session/new' || m.method === 'session/load') reply(m, { sessionId: 'session-attachments', models: { currentModelId: 'model', availableModels: [{ modelId: 'model', name: 'ACP' }] } });
        if (m.method === 'session/set_model' || m.method === 'session/set_mode') reply(m, {});
        if (m.type === 'user' || m.method === 'turn/start' || m.method === 'session/prompt') {
          this.prompts.push(m);
          if (m.type === 'user') { emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Attachments received' }] } }); emit({ type: 'result', subtype: 'success' }); }
          else if (m.method === 'turn/start') { reply(m, { turn: { id: 'turn-attachments' } }); emit({ method: 'item/agentMessage/delta', params: { delta: 'Attachments received' } }); emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); }
          else { emit({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Attachments received' } } } }); reply(m, { stopReason: 'end_turn' }); }
        }
      }); },
      onData: reader => { readers.push(reader); }, onExit: listener => { exits.push(listener); },
      stop: () => { if (!stopped) { stopped = true; for (const exit of exits) exit(new Error('CLI closed')); } },
    };
  }
}

async function setup(t: TestContext, provider = 'claude', imageCapable = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-attachments-'));
  const store = new Store(join(directory, 'state.json')); await store.open();
  const ssh = new AttachmentSsh(provider, imageCapable);
  const service = new RemoteAgentsService(store, host => new SshBackend(host, store, ssh));
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const hostId = (await service.addHost({ label: 'Files machine', connection: 'ssh://files-machine' }, { discoverModels: true })).hosts[0].id;
  const originals = new Map<string, readonly ContentBlock[]>(); let reads = 0, allowed = true;
  const access: AttachmentAccess = { image: async () => { reads++; return { data: png, mediaType: 'image/png' }; }, file: async function* () { reads++; yield file.subarray(0, 3); yield file.subarray(3); } };
  const adapter = new RemoteCliAdapter(new ChatProjects(service), { agent: () => undefined, step: () => undefined, cwd: () => '/local/workspace', workspace: async () => ({ cwd: '/srv/project', hostIds: allowed ? [hostId] : [] }), userContent: (_id, id) => originals.get(id), attachments: access }, 1);
  const options = (content: ContentBlock[], previous: GenerateOptions['messages'] = []): GenerateOptions => {
    const message = user(content); originals.set(message.id, message.content);
    return { provider: chatProviderId(provider), model: chatModelId(hostId, provider, 'model'), sessionId: SessionId('attachment-conversation'), messages: [...previous, message] };
  };
  t.after(() => adapter.close());
  return { directory, store, service, ssh, adapter, options, hostId, access, reads: () => reads, deny: () => { allowed = false; } };
}

for (const provider of ['claude', 'codex', 'grok']) test(`${provider}: images and streamed binary files reach the native protocol and replay does not re-upload`, async t => {
  const { adapter, options, ssh, store, directory } = await setup(t, provider);
  const ctx = new Context(), runtime = ctx.plugin(LlmRuntime); await runtime.await(); t.after(() => runtime.dispose());
  t.after(ctx.llm.registerAdapter(CHAT_PROVIDERS, adapter));
  const first = options([{ type: 'text', text: 'Read these attachments' }, image, document]);
  const prepared = await ctx.llm.prepareCall({ provider: first.provider, model: first.model });
  assert.deepEqual((await ctx.llm.resolveModelInfo(first.provider, first.model)).inputModalities, ['text', 'image']);
  const result = await collect(prepared.stream(first));
  assert.ok(result.some(c => c.type === 'text-delta' && c.text === 'Attachments received'));
  assert.equal(ssh.uploads.length, 2); assert.deepEqual(ssh.uploads.map(u => u.data), [png, file]);
  const prompt = ssh.prompts[0];
  const content = provider === 'claude' ? prompt.message.content : provider === 'codex' ? prompt.params.input : prompt.params.prompt;
  assert.match(content[0].text, /Read these attachments/); assert.ok(content[0].text.includes(ssh.uploads[1].path));
  assert.doesNotMatch(content[0].text, /cannot access a readable path|verbatim read-only copy saved at/);
  if (provider === 'claude') assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  else if (provider === 'codex') assert.deepEqual(content[1], { type: 'localImage', path: ssh.uploads[0].path });
  else assert.deepEqual(content[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.doesNotMatch(await readFile(join(directory, 'state.json'), 'utf8'), new RegExp(png.toString('base64')));
  const task = store.snapshot().tasks[0];
  assert.ok(!(await readFile(join(directory, 'events', `${task.id}.jsonl`), 'utf8')).includes(png.toString('base64')));
  const replay = await ctx.llm.prepareCall({ provider: first.provider, model: first.model });
  await collect(replay.stream(first)); assert.equal(ssh.uploads.length, 2); assert.equal(ssh.prompts.length, 1);
  const next = options([document], first.messages); await collect(adapter.stream(next));
  assert.equal(ssh.uploads.length, 3); assert.equal(ssh.prompts.length, 2); assert.equal(store.snapshot().tasks.length, 1);
  await serviceDelete();
  async function serviceDelete() { await adapter.projects.service.delete(task.id); await assert.rejects(access(attachmentDirectory(directory, task.id, task.id)), { code: 'ENOENT' }); }
});

test('an interrupted upload is retryable without starting a CLI turn or losing attachment bytes', async t => {
  const { adapter, options, ssh, store } = await setup(t);
  const input = options([image]); ssh.failUpload = true;
  await assert.rejects(collect(adapter.stream(input)), /upload interrupted/);
  assert.equal(ssh.prompts.length, 0); assert.equal(store.snapshot().tasks[0].agentId, undefined);
  ssh.failUpload = false; await collect(adapter.stream(input));
  assert.equal(ssh.prompts.length, 1); assert.equal(ssh.uploads.length, 1);
});

test('workspace checks and explicit image capabilities run before attachment reads or transfer', async t => {
  const denied = await setup(t); denied.deny();
  await assert.rejects(collect(denied.adapter.stream(denied.options([image, document]))), /does not belong/);
  assert.equal(denied.reads(), 0); assert.equal(denied.ssh.uploads.length, 0);
  const textOnly = await setup(t, 'grok', false);
  assert.deepEqual((await textOnly.adapter.listModels(chatProviderId('grok')))[0].inputModalities, ['text']);
  await assert.rejects(collect(textOnly.adapter.stream(textOnly.options([image]))), /does not support image/);
  assert.equal(textOnly.reads(), 0); await collect(textOnly.adapter.stream(textOnly.options([document])));
  assert.equal(textOnly.ssh.uploads.length, 1);
  const codex = await setup(t, 'codex', false);
  assert.deepEqual((await codex.adapter.resolveModel(chatProviderId('codex'), codex.options([]).model)).inputModalities, ['text']);
});

test('cancelled or corrupt attachment reads cannot publish a staged file or start a remote turn', async t => {
  const base = await setup(t), controller = new AbortController(); controller.abort();
  const cancelled = base.options([document]); cancelled.signal = controller.signal;
  await assert.rejects(collect(base.adapter.stream(cancelled)), /abort/i);
  assert.equal(base.reads(), 0); assert.equal(base.ssh.prompts.length, 0);
  await assert.rejects(stageAttachments(base.directory, randomUUID(), randomUUID(), [document], { image: base.access.image, file: async function* () { yield file.subarray(0, 2); } }), /byte count mismatch/);
  await assert.rejects(stageAttachments(base.directory, randomUUID(), randomUUID(), [document]), /attachment service/);
});

async function localSsh(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-shell-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ssh = join(root, 'ssh');
  await writeFile(ssh, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:{...process.env,SHELL:'/bin/sh'}});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 });
  const cwd = join(root, "workspace ' 中文 $(ignored)"); await mkdir(cwd);
  return { root, cwd, transport: new OpenSshTransport('ssh://upload-fixture', ssh) };
}
test('the real SSH upload command streams exact binary bytes into a private atomic copy', async t => {
  const { cwd, transport } = await localSsh(t);
  const data = Buffer.concat([file, Buffer.alloc(1024 * 1024, 0x90)]);
  const attachment: Attachment = { sha256: digest(data), bytes: data.length, name: "../../报告 ' $(ignored).bin", kind: 'file' };
  const relative = attachmentRelativePath(randomUUID(), randomUUID(), attachment);
  const source = async function* () { for (let i = 0; i < data.length; i += 32_768) yield data.subarray(i, i + 32_768); };
  const saved = await transport.upload(cwd, relative, source(), data.length, attachment.sha256);
  assert.deepEqual(await readFile(saved), data); assert.equal((await stat(saved)).mode & 0o777, 0o400);
  assert.equal((await stat(join(cwd, '.dsh-remote-agents'))).mode & 0o777, 0o700);
  await assert.rejects(transport.upload(cwd, relative, source(), data.length, '0'.repeat(64)), /checksum mismatch/);
  assert.deepEqual(await readFile(saved), data);
  assert.deepEqual((await readdir(join(saved, '..'))).filter(f => f.startsWith('.upload.')), []);
});
test('SSH upload rejects directory traversal and symlinks and cancellation leaves no partial file', async t => {
  const { root, cwd, transport } = await localSsh(t), task = randomUUID(), message = randomUUID();
  const relative = attachmentRelativePath(task, message, { sha256: digest(file), name: 'file.bin', bytes: file.length, kind: 'file' });
  await assert.rejects(transport.upload(cwd, '../escape', (async function* () { yield file; })(), file.length, digest(file)), /destination/);
  await symlink(root, join(cwd, '.dsh-remote-agents'));
  await assert.rejects(transport.upload(cwd, relative, (async function* () { yield file; })(), file.length, digest(file)));
  await rm(join(cwd, '.dsh-remote-agents'));
  const controller = new AbortController();
  const source = async function* () { yield file; await pause(5000, undefined, { signal: controller.signal }); yield file; };
  const uploading = transport.upload(cwd, relative, source(), file.length * 2, digest(Buffer.concat([file, file])), controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(uploading); await pause(100);
  await assert.rejects(access(join(cwd, relative)), { code: 'ENOENT' });
});
