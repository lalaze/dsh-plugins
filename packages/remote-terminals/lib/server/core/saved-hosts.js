import { readFile } from 'node:fs/promises';
/**
 * The machines in Remote Agents' saved state, for a process that is not Remote Agents, as a terminal's launcher is.
 * None while nothing has been saved. See `RemoteAgentsMachines.stateFile`.
 */
export async function savedHosts(stateFile) {
    let text;
    try {
        text = await readFile(stateFile, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const hosts = JSON.parse(text)?.hosts;
    if (!Array.isArray(hosts))
        throw new Error('Invalid remote agent registry');
    return hosts.filter((host) => !!host && typeof host.id === 'string' && typeof host.connection === 'string' && typeof host.label === 'string');
}
