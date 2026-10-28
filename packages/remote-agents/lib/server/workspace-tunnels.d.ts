import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HostConfig } from './domain.js';
import type { Tunnel, TunnelConfig } from './workspace-domain.js';
export declare function tunnelConfig(raw: unknown): TunnelConfig;
export declare function tunnelArguments(connection: string, config: TunnelConfig): string[];
export declare class WorkspaceTunnels {
    private readonly path;
    private readonly hosts;
    private readonly launch;
    private configs;
    private readonly live;
    private writes;
    private closed;
    constructor(path: string, hosts: () => HostConfig[], launch?: (args: string[]) => ChildProcessWithoutNullStreams);
    open(): Promise<void>;
    list(hostId: string): Tunnel[];
    private mutate;
    add(input: unknown): Promise<Tunnel>;
    start(id: string, hostId: string): Promise<Tunnel>;
    stop(id: string, hostId: string): void;
    remove(id: string, hostId: string): Promise<void>;
    removeHost(hostId: string): Promise<void>;
    close(): Promise<void>;
}
