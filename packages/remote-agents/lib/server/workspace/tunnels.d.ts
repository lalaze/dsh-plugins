import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HostConfig } from '../core/domain.js';
import type { Tunnel, TunnelConfig } from './domain.js';
export declare function tunnelConfig(raw: unknown): TunnelConfig;
export interface TunnelNetwork {
    /** This machine's addresses, without loopback. */
    addresses(): string[];
    /** The addresses a name stands for; none when they cannot be found out in time. */
    lookup(host: string): Promise<string[]>;
}
/**
 * Where a local tunnel listens: this machine, and the address the browser starting it reached DSH at, so that its link opens
 * from there. What it forwards often has no login of its own, so it is not offered to every network this machine is on.
 * Behind a proxy, or a resolver that hides the real address, that address cannot be told, and the private tailnet is used.
 * @param access - the browser's host name for DSH; an authenticated client's word, honored only for this machine's own addresses.
 */
export declare function listenAddresses(access: unknown, network?: TunnelNetwork): Promise<string[]>;
export declare function tunnelArguments(connection: string, config: TunnelConfig, listen?: readonly string[]): string[];
export declare class WorkspaceTunnels {
    private readonly path;
    private readonly hosts;
    private readonly launch;
    private readonly network;
    private configs;
    private readonly live;
    private writes;
    private closed;
    constructor(path: string, hosts: () => HostConfig[], launch?: (args: string[]) => ChildProcessWithoutNullStreams, network?: TunnelNetwork);
    open(): Promise<void>;
    list(hostId: string): Tunnel[];
    private mutate;
    add(input: unknown): Promise<Tunnel>;
    /** @param access - the browser's host name for DSH; see {@link listenAddresses}. A tunnel already running is left as it is. */
    start(id: string, hostId: string, access?: unknown): Promise<Tunnel>;
    stop(id: string, hostId: string): void;
    remove(id: string, hostId: string): Promise<void>;
    removeHost(hostId: string): Promise<void>;
    close(): Promise<void>;
}
