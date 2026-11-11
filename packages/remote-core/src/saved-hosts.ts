import { readFile } from 'node:fs/promises';
import type { HostConfig } from './domain.js';

/**
 * The machines in Remote Agents' saved state, for a process that is not Remote Agents, as a terminal's launcher is.
 * None while nothing has been saved. See `RemoteAgentsMachines.stateFile`.
 */
export async function savedHosts(stateFile: string): Promise<HostConfig[]> {
  let text: string;
  try { text = await readFile(stateFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const hosts: unknown = (JSON.parse(text) as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) throw new Error('Invalid remote agent registry');
  return hosts.filter((host): host is HostConfig => !!host && typeof host.id === 'string' && typeof host.connection === 'string' && typeof host.label === 'string');
}
