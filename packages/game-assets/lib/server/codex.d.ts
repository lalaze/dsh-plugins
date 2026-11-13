import type { Aspect } from './domain.js';
export interface CodexRequest {
    prompt: string;
    /** Absolute paths of reference images. */
    references: string[];
    aspect: Aspect;
    transparent: boolean;
    /** The model that drives Codex; Codex's default when empty. The picture itself always comes from Codex's image tool. */
    model?: string;
}
export interface CodexOptions {
    /** Starts Codex through the user's login shell, for a process whose PATH may not reach it, such as DSH started from the Dock. */
    loginShell?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The command to run; tests put a stand-in here. */
    command?: string;
}
export interface CodexPicture {
    data: Buffer;
    mediaType: string;
    width?: number;
    height?: number;
    text?: string;
}
export declare const CODEX_TIMEOUT_MS = 300000;
/** What Codex is asked: one picture from its image tool, nothing else. */
export declare function codexPrompt(request: CodexRequest): string;
/** Runs `codex exec` once and answers the picture it made. */
export declare function runCodex(request: CodexRequest, options?: CodexOptions): Promise<CodexPicture>;
