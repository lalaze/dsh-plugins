import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { SshBackend } from '../src/backend.js';
import { OpenSshTransport } from '../src/ssh.js';
import { RemoteAgentsService } from '../src/service.js';
import type { Cursor } from '../src/domain.js';
import { Store } from '../src/store.js';

/**
 * The production SSH command wrapper and relay, run by a local shell with its own HOME instead of
 * over SSH. `offline` refuses new connections; `drop()` kills attachments like a lost SSH session.
 */
export class LocalTransport extends OpenSshTransport {
  offline = false;
  readonly processes = new Map<ChildProcessWithoutNullStreams, string>();
  constructor(readonly home: string, private readonly env: Record<string, string> = {}) { super('ssh://builder@localhost'); }
  protected override spawnRemote(command: string): ChildProcessWithoutNullStreams {
    const child = this.offline
      ? spawn('/bin/sh', ['-c', 'echo "ssh: connect to host localhost port 22: Connection refused" >&2; exit 255'], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: this.home, SHELL: '/bin/sh', ...this.env } });
    this.processes.set(child, command); child.on('close', () => this.processes.delete(child));
    return child;
  }
  /** Kill relay attachments, as when the network drops. */
  drop(): number {
    let count = 0;
    for (const [child, command] of this.processes) if (command.includes(' attach ')) { child.kill('SIGKILL'); count++; }
    return count;
  }
}
export const waitFor = async <T>(read: () => T | Promise<T>, message: string, timeout = 15_000): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await pause(20);
  }
};
export async function relayHarness(t: TestContext, env: Record<string, string> = {}, options: { longHome?: boolean } = {}) {
  // A long HOME puts the relay's Unix socket path beyond the ~104–108 byte platform limit.
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-')), home = join(root, ...(options.longHome ? ['a-very-long-home-directory-name-'.repeat(4)] : []), 'home'), state = join(root, 'state');
  const bin = join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true }); await mkdir(join(home, 'project'), { recursive: true });
  const source = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.mjs');
  for (const name of ['codex', 'claude', 'dsh']) {
    await writeFile(join(bin, name), `#!${process.execPath}\n${(await readFile(source, 'utf8'))}`); await chmod(join(bin, name), 0o755);
  }
  await copyFile(source, join(root, 'fake-cli.mjs'));
  const relays = join(home, '.dsh-remote-agents', 'relays-v1');
  const services: RemoteAgentsService[] = [];
  /** A DSH instance: its own store, service and transport, sharing the remote HOME. */
  const open = async (transport = new LocalTransport(home, env)) => {
    const store = new Store(join(state, 'state.json')); await store.open();
    const service = new RemoteAgentsService(store, host => new SshBackend(host, store, transport));
    services.push(service);
    return { store, service, transport };
  };
  const relayPids = async () => {
    const pids: number[] = [];
    for (const id of existsSync(relays) ? await readdir(relays) : []) {
      try { const meta = JSON.parse(await readFile(join(relays, id, 'meta.json'), 'utf8')); pids.push(meta.pid, -meta.cli); } catch {}
    }
    return pids;
  };
  /** Every process ever started under a relay, including ones whose directory was deleted. */
  const started: number[] = [];
  const remember = async () => { for (const pid of await relayPids()) if (!started.includes(pid)) started.push(pid); return started; };
  t.after(async () => {
    for (const service of services) await service.close().catch(() => {});
    for (const pid of await remember()) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const first = await open();
  const hostId = (await first.service.addHost({ label: 'Local relay host', connection: 'ssh://builder@localhost' })).hosts[0].id;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const lines = async (file: string) => existsSync(join(home, file)) ? (await readFile(join(home, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, home, relays, hostId, first, open, alive, lines, relayPids, remember, cwd: join(home, 'project'),
    gate: () => writeFile(join(home, 'gate'), ''),
    request: (provider: string, prompt: string) => ({ id: `task-${Math.random().toString(36).slice(2, 12)}`, hostId, cwd: join(home, 'project'), provider, model: 'fake-model', prompt }) };
}
/** Assistant text recorded for an agent. */
export async function transcript(service: RemoteAgentsService, id: string): Promise<{ text: string; types: string[]; entries: { item: Record<string, unknown> }[] }> {
  const entries: { item: Record<string, unknown> & { type: string } }[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = (await service.detail(id, cursor, 'after')).timeline!;
    entries.push(...page.entries); cursor = page.endCursor ?? cursor;
    if (!page.hasNewer) break;
  }
  return { text: entries.filter(e => e.item.type === 'assistant_message').map(e => String(e.item.text)).join(''), types: entries.map(e => e.item.type), entries };
}
