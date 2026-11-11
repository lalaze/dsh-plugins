import type { HostConfig } from './domain.js';
/**
 * The machines in Remote Agents' saved state, for a process that is not Remote Agents, as a terminal's launcher is.
 * None while nothing has been saved. See `RemoteAgentsMachines.stateFile`.
 */
export declare function savedHosts(stateFile: string): Promise<HostConfig[]>;
