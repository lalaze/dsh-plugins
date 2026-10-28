import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectionInput } from './ssh.js';
import { dshHome, sameEndpoint, sshEndpoint } from './workspace-access.js';
import { RemoteError } from './domain.js';
import type { RemoteAgentsService } from './service.js';
import type { LegacyMachine } from './workspace-domain.js';

/** Explicit, read-only migration of connection references; never imports another plugin's secrets. */
export class WorkspaceMigration {
  constructor(private readonly service: RemoteAgentsService, private readonly home = dshHome(), private readonly endpoint = sshEndpoint) {}
  private async records(): Promise<Record<string, unknown>[]> {
    try {
      const file = await readFile(join(this.home, 'remote-workspaces', 'machines.json'), 'utf8');
      if (Buffer.byteLength(file) > 1_048_576) throw new Error('Saved machine registry is too large');
      const value = JSON.parse(file);
      if (!Array.isArray(value.list)) throw new Error('Invalid saved machine registry');
      if (value.list.length > 64) throw new Error('Import supports up to 64 saved machines at a time');
      return value.list.filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list(): Promise<LegacyMachine[]> {
    const candidates = await this.records(), hosts = this.service.store.hosts();
    const configured = await this.service.sshConfig();
    const known = await Promise.all(hosts.map(async h => { try { return await this.endpoint(h.connection); } catch { return undefined; } }));
    return Promise.all(candidates.map(async row => {
      const base = { id: String(row.id ?? ''), label: String(row.name ?? row.host ?? '').slice(0, 100), connection: '', available: false, imported: false };
      try {
        const host = String(row.host ?? ''), user = String(row.username ?? ''), port = Number(row.port) || 22;
        const named = configured.hosts.some(h => h.alias === host);
        const connection = connectionInput(row.useSshConfig || named ? host : `${user ? `${user}@` : ''}${host.includes(':') ? `[${host}]` : host}:${port}`);
        const endpoint = await this.endpoint(connection);
        const imported = known.some(saved => saved && sameEndpoint(endpoint, saved));
        // A native-only credential cannot be silently replaced with a different authentication policy.
        const reason = row.password || row.passphrase || row.credentialBackend && row.credentialBackend !== 'plain' || !named && !row.useSshConfig && (row.proxy || row.privateKeyPath)
          ? 'Move this connection’s authentication and jump-host settings into ~/.ssh/config first.' : undefined;
        return { ...base, connection, available: !reason, imported, ...(reason ? { reason } : {}) };
      } catch { return { ...base, reason: 'This machine does not have a supported OpenSSH connection.' }; }
    }));
  }
  async import(id: string): Promise<unknown> {
    const entry = (await this.list()).find(m => m.id === id);
    if (!entry?.available) throw new RemoteError(entry?.reason ?? 'Saved machine not found', 409);
    if (entry.imported) return this.service.snapshot();
    return this.service.addHost({ label: entry.label, connection: entry.connection, enabledProviders: [] });
  }
}
