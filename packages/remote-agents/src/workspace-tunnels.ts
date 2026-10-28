import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connectionInput } from './ssh.js';
import { field, identifier, record, RemoteError } from './domain.js';
import type { HostConfig } from './domain.js';
import type { Tunnel, TunnelConfig } from './workspace-domain.js';

export function tunnelConfig(raw: unknown): TunnelConfig {
  const v = record(raw), port = (value: unknown) => { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new RemoteError('Enter a port between 1 and 65535'); return value; };
  if (v.direction !== 'local' && v.direction !== 'reverse') throw new RemoteError('Invalid tunnel direction');
  const targetHost = field(v.targetHost ?? '127.0.0.1', 'target host', 253);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(targetHost)) throw new RemoteError('Invalid tunnel target host');
  return { id: identifier(v.id), hostId: identifier(v.hostId), direction: v.direction, listenPort: port(v.listenPort), targetPort: port(v.targetPort), targetHost };
}
export function tunnelArguments(connection: string, config: TunnelConfig): string[] {
  const url = new URL(connectionInput(connection));
  const target = `${decodeURIComponent(url.username) ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`;
  // User-facing local previews use the machine's Tailscale address. Reverse listeners stay remote-loopback only.
  return ['-v', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(url.port ? ['-p', url.port] : []), config.direction === 'local' ? '-L' : '-R',
    `${config.direction === 'local' ? '0.0.0.0' : '127.0.0.1'}:${config.listenPort}:${config.targetHost}:${config.targetPort}`, '--', target];
}
export class WorkspaceTunnels {
  private configs: TunnelConfig[] = [];
  private readonly live = new Map<string, { child: ChildProcessWithoutNullStreams; state: Tunnel }>();
  private writes = Promise.resolve();
  private closed = false;
  constructor(private readonly path: string, private readonly hosts: () => HostConfig[], private readonly launch = (args: string[]) => spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })) {}
  async open(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid saved tunnels');
      this.configs = value.map(tunnelConfig);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  list(hostId: string): Tunnel[] { return this.configs.filter(c => c.hostId === hostId).map(c => structuredClone(this.live.get(c.id)?.state ?? { ...c, status: 'stopped' })); }
  private mutate(change: (configs: TunnelConfig[]) => TunnelConfig[]): Promise<void> {
    const next = this.writes.then(async () => {
      if (this.closed) throw new RemoteError('Tunnel service is closed', 503);
      const configs = change(this.configs), tmp = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try { await writeFile(tmp, JSON.stringify(configs), { mode: 0o600, flag: 'wx' }); await rename(tmp, this.path); this.configs = configs; }
      finally { await rm(tmp, { force: true }); }
    });
    this.writes = next.catch(() => {}); return next;
  }
  async add(input: unknown): Promise<Tunnel> {
    const config = tunnelConfig(input);
    if (!this.hosts().some(h => h.id === config.hostId)) throw new RemoteError('Remote host not found', 404);
    await this.mutate(configs => {
      if (configs.length >= 32) throw new RemoteError('Up to 32 tunnels can be saved');
      if (configs.some(c => c.id === config.id || c.direction === config.direction && c.listenPort === config.listenPort && (c.direction === 'local' || c.hostId === config.hostId))) throw new RemoteError('This tunnel or listening port is already saved', 409);
      return [...configs, config];
    });
    return { ...config, status: 'stopped' };
  }
  async start(id: string, hostId: string): Promise<Tunnel> {
    const config = this.configs.find(c => c.id === id && c.hostId === hostId), host = this.hosts().find(h => h.id === hostId);
    if (!config || !host) throw new RemoteError('Tunnel not found', 404);
    if (this.closed) throw new RemoteError('Tunnel service is closed', 503);
    const previous = this.live.get(id);
    if (previous?.state.status === 'running') return structuredClone(previous.state);
    if (previous?.state.status === 'starting') throw new RemoteError('Tunnel is already starting', 409);
    const child = this.launch(tunnelArguments(host.connection, config));
    const entry: { child: ChildProcessWithoutNullStreams; state: Tunnel } = { child, state: { ...config, status: 'starting' } }; this.live.set(id, entry);
    child.stdin.end(); child.stdout.resume();
    return new Promise((accept, reject) => {
      let output = '', ready = false;
      const timer = setTimeout(() => fail('SSH tunnel startup timed out'), 15000);
      const fail = (message: string) => {
        clearTimeout(timer); entry.state.status = 'error'; entry.state.error = message.slice(-1500); child.kill();
        if (!ready) reject(new RemoteError(entry.state.error, 502));
      };
      child.stderr.on('data', data => {
        output = (output + data).slice(-8000);
        if (!ready && /Entering interactive session|remote forward success/i.test(output)) {
          ready = true; clearTimeout(timer); entry.state.status = 'running'; accept(structuredClone(entry.state));
        }
      });
      child.on('error', error => fail(error.message));
      child.on('close', code => {
        clearTimeout(timer);
        if (entry.state.status === 'stopped') { if (!ready) reject(new RemoteError('Tunnel was stopped', 409)); return; }
        fail(output.split('\n').filter(line => line && !line.startsWith('debug')).slice(-3).join('\n') || `SSH tunnel exited (${code})`);
      });
    });
  }
  stop(id: string, hostId: string): void {
    if (!this.configs.some(c => c.id === id && c.hostId === hostId)) throw new RemoteError('Tunnel not found', 404);
    const live = this.live.get(id); if (live) { live.state.status = 'stopped'; live.child.kill(); this.live.delete(id); }
  }
  async remove(id: string, hostId: string): Promise<void> { this.stop(id, hostId); await this.mutate(configs => configs.filter(c => c.id !== id || c.hostId !== hostId)); }
  async removeHost(hostId: string): Promise<void> {
    for (const config of this.configs.filter(c => c.hostId === hostId)) this.stop(config.id, hostId);
    await this.mutate(configs => configs.filter(c => c.hostId !== hostId));
  }
  async close(): Promise<void> { await this.writes; this.closed = true; for (const live of this.live.values()) { live.state.status = 'stopped'; live.child.kill(); } this.live.clear(); }
}
