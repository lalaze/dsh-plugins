import { type ChildProcessWithoutNullStreams } from 'node:child_process';
export declare const quote: (value: string) => string;
/** Keep a compatible configured Node; otherwise use the newest installed runtime >=22. */
export declare const REMOTE_PATH = "\ndsh_initial_node=\"$(command -v node 2>/dev/null || true)\"\nPATH=\"$HOME/.local/bin:$HOME/.gemini/bin:$HOME/.grok/bin:$HOME/.codebuddy/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\"\ndsh_nvm_root=\"${NVM_DIR:-$HOME/.nvm}\"\nfor dsh_node_bin in \"$dsh_nvm_root\"/versions/node/*/bin; do\n  if [ -d \"$dsh_node_bin\" ]; then PATH=\"$PATH:$dsh_node_bin\"; fi\ndone\ndsh_best_node=; dsh_best_major=0; dsh_best_minor=0; dsh_best_patch=0\ndsh_consider_node() {\n  [ -x \"$1\" ] && [ ! -d \"$1\" ] || return 0\n  dsh_version=\"$(\"$1\" --version 2>/dev/null)\" || return 0\n  dsh_version=\"${dsh_version#v}\"\n  dsh_major=\"${dsh_version%%.*}\"; dsh_remainder=\"${dsh_version#*.}\"\n  dsh_minor=\"${dsh_remainder%%.*}\"; dsh_patch=\"${dsh_remainder#*.}\"; dsh_patch=\"${dsh_patch%%-*}\"\n  case \"$dsh_major:$dsh_minor:$dsh_patch\" in *[!0-9:]*|*::*|:*|*:) return 0;; esac\n  [ \"$dsh_major\" -ge 22 ] || return 0\n  if [ \"$dsh_major\" -gt \"$dsh_best_major\" ] ||\n    { [ \"$dsh_major\" -eq \"$dsh_best_major\" ] && [ \"$dsh_minor\" -gt \"$dsh_best_minor\" ]; } ||\n    { [ \"$dsh_major\" -eq \"$dsh_best_major\" ] && [ \"$dsh_minor\" -eq \"$dsh_best_minor\" ] && [ \"$dsh_patch\" -gt \"$dsh_best_patch\" ]; }; then\n    dsh_best_node=\"$1\"; dsh_best_major=\"$dsh_major\"; dsh_best_minor=\"$dsh_minor\"; dsh_best_patch=\"$dsh_patch\"\n  fi\n}\ndsh_consider_node \"$dsh_initial_node\"\nif [ -z \"$dsh_best_node\" ]; then\n  for dsh_node_candidate in \"$(command -v node 2>/dev/null || true)\" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@22/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@22/bin/node /usr/local/opt/node@24/bin/node \"$dsh_nvm_root\"/versions/node/*/bin/node; do\n    dsh_consider_node \"$dsh_node_candidate\"\n  done\nfi\nif [ -n \"$dsh_best_node\" ]; then PATH=\"${dsh_best_node%/*}:$PATH\"; fi\nexport PATH\n";
export declare function connectionInput(value: unknown): string;
export interface Child {
    /** `inputId` lets a relay drop a line it already delivered; direct pipes ignore it. */
    write(value: string, inputId?: string): void;
    /** Release this connection. A relay keeps its CLI running; a direct SSH pipe ends it. */
    stop(): void;
    onData(callback: (data: Buffer) => void): void;
    onExit(callback: (error: Error) => void): void;
    /** Byte offset of the first output byte this child delivers. */
    readonly offset?: number;
}
export interface StartOptions {
    stderr?(data: Buffer): void;
}
export interface SshTransport {
    /** `login: false` skips the remote login environment; for commands that need no CLI configuration. */
    exec(script: string, timeout?: number, options?: {
        login?: boolean;
    }): Promise<string>;
    start(cwd: string, argv: string[], options?: StartOptions): Child;
    upload?(cwd: string, relativePath: string, data: AsyncIterable<Uint8Array>, bytes: number, sha256: string, signal?: AbortSignal): Promise<string>;
    /** Commands run in a POSIX shell where a detached relay can outlive the connection. */
    readonly relays?: boolean;
    /** Bounded binary transfer through the same verified SSH connection settings. */
    transfer?(script: string, options: {
        input?: AsyncIterable<Uint8Array>;
        maxBytes: number;
        signal?: AbortSignal;
    }): Promise<Buffer>;
}
export declare class OpenSshTransport implements SshTransport {
    private readonly binary;
    readonly relays: boolean;
    private readonly args;
    constructor(connection: string, binary?: string);
    private spawn;
    transfer(script: string, options: {
        input?: AsyncIterable<Uint8Array>;
        maxBytes: number;
        signal?: AbortSignal;
    }): Promise<Buffer>;
    /** Runs a POSIX shell command on the SSH host. */
    protected spawnRemote(command: string): ChildProcessWithoutNullStreams;
    exec(script: string, timeout?: number, options?: {
        login?: boolean;
    }): Promise<string>;
    /** Binary stdin with backpressure; atomic, private, digest-verified remote copies. */
    upload(cwd: string, relativePath: string, data: AsyncIterable<Uint8Array>, bytes: number, sha256: string, signal?: AbortSignal): Promise<string>;
    start(cwd: string, argv: string[], options?: StartOptions): Child;
}
export type WireMessage = Record<string, any>;
/** Byte range of one output line in the CLI's output stream. */
export interface Frame {
    start: number;
    end: number;
}
/** JSONL supports native Codex, ACP JSON-RPC and Claude's control frames. */
export declare class JsonlPeer {
    private readonly child;
    /** Request IDs stay unique across reconnections: a replayed response can never answer a newer request. */
    private readonly prefix;
    private nextId;
    private pending;
    private listeners;
    private exits;
    private ended?;
    private processed;
    constructor(child: Child);
    /** Byte offset after the last dispatched line. */
    get position(): number;
    private dispatch;
    get alive(): boolean;
    onMessage(listener: (message: WireMessage, frame: Frame) => void): void;
    onExit(listener: (error: Error) => void): void;
    waitForMessage(predicate: (message: WireMessage) => boolean, timeout?: number): Promise<WireMessage>;
    send(message: WireMessage, inputId?: string): void;
    request(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    control(request: Record<string, unknown>, timeout?: number): Promise<any>;
    private wait;
    close(): void;
    private finish;
}
