import type { NativeSnapshot } from './native-protocol.js';
export interface NativeProjectMapping {
    hostId: string;
    projectKey: string;
    localDirectory: string;
}
/** Optional v1 envelope metadata; absent on legacy remote-workspace records. */
export interface NativeProjectSnapshot extends NativeSnapshot {
    projectKind?: 'local' | 'remote';
}
export type NativeRuntimePlacement = {
    kind: 'local';
    project: string;
    localDirectory: string;
} | {
    kind: 'remote';
    project: string;
};
/** No expansion, directory guessing, mkdir, file copying or credential access. */
export declare function nativeLocalDirectory(path: string): string;
/** Machine-local consent, stored separately from the shared history and replica journal. */
export declare class NativePlacements {
    readonly path: string;
    private mappings;
    constructor(path: string);
    list(hostId: string): NativeProjectMapping[];
    get(hostId: string, projectKey: string): NativeProjectMapping | undefined;
    receiver(hostId: string, projectKey: string): NativeRuntimePlacement & {
        kind: 'local';
    };
    source(hostId: string, cwd: string): string;
    set(hostId: string, projectKey: string, localDirectory: string, confirmedDirectory: string): NativeProjectMapping;
}
