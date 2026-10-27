import { type Child, type SshTransport } from './ssh.js';
/**
 * Runs on the SSH host and owns one CLI process, so the CLI outlives DSH and its SSH connection.
 *
 * `start` launches a detached daemon (its own session, immune to SIGHUP) that appends the CLI's
 * stdout to `out.log` and accepts input lines `<inputId> <json>` over a private Unix socket. Each
 * input ID is delivered once, so a client can resend unacknowledged input after reconnecting.
 * Partial lines from a dropped connection are discarded. `attach` streams `out.log` from a byte
 * offset on stdout and reports `attached`, `ack`, `exit`, `missing` and `evicted` on stderr.
 * Only `exit` means the CLI ended; any other end of an attachment is a lost connection.
 */
export declare const RELAY_SCRIPT: string;
export declare const RELAY_VERSION: string;
/** The relay reported that its CLI ended, or that it can no longer be reached. */
export declare class RelayExit extends Error {
    readonly exit: {
        code?: number | null;
        signal?: string | null;
        reason?: string;
        error?: string;
        stderr?: string;
    };
    constructor(message: string, exit?: {
        code?: number | null;
        signal?: string | null;
        reason?: string;
        error?: string;
        stderr?: string;
    });
}
export declare class RelayReleased extends Error {
    constructor(message?: string);
}
export declare function relayExitMessage(exit: RelayExit['exit']): string;
export interface RelayState {
    connected: boolean;
    error?: string;
}
/**
 * A reconnecting attachment to one relay. Output continues from the exact byte offset, and input
 * that was not acknowledged is resent after reconnecting; the relay drops already delivered IDs.
 */
export declare class RelayLink implements Child {
    private readonly transport;
    readonly id: string;
    private readonly prepare;
    private readonly onState;
    private proc?;
    private readonly unacked;
    private readonly data;
    private readonly exits;
    private readonly prefix;
    private nextInput;
    private bytes;
    private ended?;
    private attempt;
    private timer?;
    private state;
    private prepared;
    private installs;
    /** `prepare(reinstall)` makes sure the current relay script is installed on the host. */
    constructor(transport: SshTransport, id: string, offset: number, prepare: (reinstall: boolean) => Promise<void>, onState?: (state: RelayState) => void);
    readonly offset: number;
    get connected(): boolean;
    get error(): string | undefined;
    get alive(): boolean;
    open(): void;
    /** Resolves once attached; rejects when the relay ended or the timeout passed. */
    ready(timeout: number): Promise<void>;
    private readonly waiters;
    private setState;
    private connect;
    private retry;
    write(value: string, inputId?: string): void;
    /** Stop reading. The remote CLI keeps running. */
    stop(): void;
    private end;
    onData(callback: (data: Buffer) => void): void;
    onExit(callback: (error: Error) => void): void;
}
/** Relay commands on one SSH host. */
export declare class RelayClient {
    private readonly transport;
    private constructor();
    /** Install the relay script once per version; unavailable without Node.js 18 or newer on the host. */
    static open(transport: SshTransport): Promise<RelayClient | undefined>;
    private command;
    launch(id: string, cwd: string, argv: string[]): Promise<void>;
    /** Stop each CLI if it still runs and delete its saved output; returns the relays confirmed removed. */
    remove(ids: string[], timeout?: number): Promise<string[]>;
}
