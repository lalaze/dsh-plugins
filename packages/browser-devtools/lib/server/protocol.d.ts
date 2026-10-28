/** The window and DSH renderer have separate credentials; only DSH can answer commands. */
export interface PageState {
    url: string;
    title: string;
    revision: number;
    ready: boolean;
    locale: 'en' | 'zh';
    dark: boolean;
}
export interface Command {
    id: string;
    code: string;
    gesture: boolean;
    revision: number;
}
export interface Reply {
    id: string;
    value?: unknown;
    error?: string;
}
export interface SessionKey {
    id: string;
    token: string;
}
export declare class BridgeError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export declare function record(value: unknown): Record<string, unknown>;
export declare function string(value: unknown, max?: number): string;
export declare function pageState(value: unknown): PageState;
