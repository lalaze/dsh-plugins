export declare const quote: (value: string) => string;
/** Keep a compatible configured Node; otherwise use the newest installed runtime >=22. */
export declare const REMOTE_PATH = "\ndsh_initial_node=\"$(command -v node 2>/dev/null || true)\"\nPATH=\"$HOME/.local/bin:$HOME/.gemini/bin:$HOME/.grok/bin:$HOME/.codebuddy/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\"\ndsh_nvm_root=\"${NVM_DIR:-$HOME/.nvm}\"\nfor dsh_node_bin in \"$dsh_nvm_root\"/versions/node/*/bin; do\n  if [ -d \"$dsh_node_bin\" ]; then PATH=\"$PATH:$dsh_node_bin\"; fi\ndone\ndsh_best_node=; dsh_best_major=0; dsh_best_minor=0; dsh_best_patch=0\ndsh_consider_node() {\n  [ -x \"$1\" ] && [ ! -d \"$1\" ] || return 0\n  dsh_version=\"$(\"$1\" --version 2>/dev/null)\" || return 0\n  dsh_version=\"${dsh_version#v}\"\n  dsh_major=\"${dsh_version%%.*}\"; dsh_remainder=\"${dsh_version#*.}\"\n  dsh_minor=\"${dsh_remainder%%.*}\"; dsh_patch=\"${dsh_remainder#*.}\"; dsh_patch=\"${dsh_patch%%-*}\"\n  case \"$dsh_major:$dsh_minor:$dsh_patch\" in *[!0-9:]*|*::*|:*|*:) return 0;; esac\n  [ \"$dsh_major\" -ge 22 ] || return 0\n  if [ \"$dsh_major\" -gt \"$dsh_best_major\" ] ||\n    { [ \"$dsh_major\" -eq \"$dsh_best_major\" ] && [ \"$dsh_minor\" -gt \"$dsh_best_minor\" ]; } ||\n    { [ \"$dsh_major\" -eq \"$dsh_best_major\" ] && [ \"$dsh_minor\" -eq \"$dsh_best_minor\" ] && [ \"$dsh_patch\" -gt \"$dsh_best_patch\" ]; }; then\n    dsh_best_node=\"$1\"; dsh_best_major=\"$dsh_major\"; dsh_best_minor=\"$dsh_minor\"; dsh_best_patch=\"$dsh_patch\"\n  fi\n}\ndsh_consider_node \"$dsh_initial_node\"\nif [ -z \"$dsh_best_node\" ]; then\n  for dsh_node_candidate in \"$(command -v node 2>/dev/null || true)\" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@22/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@22/bin/node /usr/local/opt/node@24/bin/node \"$dsh_nvm_root\"/versions/node/*/bin/node; do\n    dsh_consider_node \"$dsh_node_candidate\"\n  done\nfi\nif [ -n \"$dsh_best_node\" ]; then PATH=\"${dsh_best_node%/*}:$PATH\"; fi\nexport PATH\n";
export declare function connectionInput(value: unknown): string;
export interface Child {
    write(value: string): void;
    stop(): void;
    onData(callback: (data: Buffer) => void): void;
    onExit(callback: (error: Error) => void): void;
}
export interface SshTransport {
    exec(script: string, timeout?: number): Promise<string>;
    start(cwd: string, argv: string[]): Child;
    upload?(cwd: string, relativePath: string, data: AsyncIterable<Uint8Array>, bytes: number, sha256: string, signal?: AbortSignal): Promise<string>;
}
export declare class OpenSshTransport implements SshTransport {
    private readonly binary;
    private readonly args;
    constructor(connection: string, binary?: string);
    private spawn;
    exec(script: string, timeout?: number): Promise<string>;
    /** Binary stdin with backpressure; atomic, private, digest-verified remote copies. */
    upload(cwd: string, relativePath: string, data: AsyncIterable<Uint8Array>, bytes: number, sha256: string, signal?: AbortSignal): Promise<string>;
    start(cwd: string, argv: string[]): Child;
}
export type WireMessage = Record<string, any>;
/** JSONL supports native Codex, ACP JSON-RPC and Claude's control frames. */
export declare class JsonlPeer {
    private readonly child;
    private nextId;
    private pending;
    private listeners;
    private exits;
    private ended?;
    constructor(child: Child);
    get alive(): boolean;
    onMessage(listener: (message: WireMessage) => void): void;
    onExit(listener: (error: Error) => void): void;
    waitForMessage(predicate: (message: WireMessage) => boolean, timeout?: number): Promise<WireMessage>;
    send(message: WireMessage): void;
    request(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    control(request: Record<string, unknown>, timeout?: number): Promise<any>;
    private wait;
    close(): void;
    private finish;
}
