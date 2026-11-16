import type { Hello, MachineInfo } from './model.js';
import type { TailnetStatus } from './tailscale.js';
/** A stable mount id for one listener URL. */
export declare const machineIdOf: (url: string) => string;
/** `http://host:port` with no path: what every candidate and the book are keyed by. */
export declare function normalizeUrl(text: string): string | undefined;
interface Candidate {
    url: string;
    source: 'tailnet' | 'static';
    online: boolean;
    name?: string;
    os?: string;
    lastSeen?: number;
}
/** Who to probe this round. */
export declare function candidatesOf(status: TailnetStatus | undefined, port: number, statics: readonly string[], discover: boolean): Candidate[];
/** A hello probe's failure in a few words. */
export declare function probeReason(error: unknown): string;
export declare function probeHello(url: string, timeoutMs?: number): Promise<Hello>;
export declare class MachineBook {
    private readonly file;
    private readonly selfId;
    private remembered;
    private current;
    private listeners;
    constructor(file: string, selfId: () => string);
    load(): void;
    list(): MachineInfo[];
    get(id: string): MachineInfo | undefined;
    onChange(listener: () => void): () => void;
    /**
     * Probe every candidate and replace the list with what answered (and what is remembered). A machine Tailscale calls
     * offline is still asked, briefly, when this book knew it: Tailscale's flag is the coordination server's view, and a
     * machine whose Tailscale lost that server (seen with the MacBook Air on a relay) stays reachable over the tailnet.
     */
    refresh(candidates: Candidate[], probe?: (url: string, timeoutMs?: number) => Promise<Hello>): Promise<void>;
    private save;
}
export {};
