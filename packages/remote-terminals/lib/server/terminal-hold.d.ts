/**
 * A connection this notices has gone inside 15 seconds; the usual keepalive, 45 seconds of a frozen terminal, is for
 * connections nobody is looking at.
 */
export declare const TERMINAL_KEEPALIVE: string[];
/**
 * OpenSSH 9.5 and later hide typing rhythm by sending keystrokes on a 20 ms clock, followed by fake ones. Measured on 9.9:
 * 327 bytes a key instead of 36, and an echo p95 of 27.6 ms instead of 1.6 ms on loopback. TCP delivers in order, so on a link that drops
 * packets each extra one is another chance for typing to stall until a retransmission. Older versions do not know the option.
 */
export declare const TERMINAL_TYPING: string[];
export interface HoldOptions {
    /** Arguments to ssh up to the host, whatever the command. Absent for this computer: see `local`. */
    ssh?: string[];
    /**
     * For a terminal on this computer: the environment its commands start from, as an SSH login's would, since they run in
     * a local shell instead. The holder then outlives DSH as it outlives a connection.
     */
    local?: NodeJS.ProcessEnv;
    /** This terminal's holder on the host. See holder-protocol.ts. */
    holder: string;
    /** Run by a new holder. Unused if it is already running. */
    command: string;
    /** Prints the conversation again at the terminal's width, for a new holder to rebuild the scrollback with; see holder-reflow.ts. */
    history?: string;
    /** The holder's script on this machine and its version, which names it on the host. */
    script: {
        path: string;
        version: string;
    };
    output?: NodeJS.WritableStream;
    input?: NodeJS.ReadStream;
}
export declare const attachCommand: ({ holder, command, history, script }: Pick<HoldOptions, "holder" | "command" | "history" | "script">) => string;
/**
 * Keep this terminal connected to its holder on the host until it ends, reconnecting whenever the connection is lost.
 * @returns the terminal's exit code, or `direct` if the host cannot hold a terminal.
 */
export declare function holdTerminal(options: HoldOptions): Promise<number | 'direct'>;
