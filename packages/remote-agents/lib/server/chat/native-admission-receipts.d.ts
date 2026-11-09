import { type NativeEvent } from './native-protocol.js';
import { type NativeWorkRequest } from './native-autonomy.js';
export type AdmissionKind = 'queue' | 'goal';
interface Admission {
    kind: AdmissionKind;
    sessionId: string;
    cut: number;
    prefix: string;
    state: 'pending' | 'accepted' | 'rejected';
    proofSeq?: number;
    proofDigest?: string;
    noop?: boolean;
}
/** Local admission metadata only. Native history stays append-only and exact.
 * The cut excludes imported/source inbox records with the same message ID. */
export declare class NativeAdmissionReceipts {
    readonly path: string;
    private rows;
    constructor(path: string);
    key(kind: AdmissionKind, sessionId: string, payload: unknown): string;
    get(key: string): Admission | undefined;
    begin(kind: AdmissionKind, sessionId: string, payload: unknown, events: readonly NativeEvent[]): string;
    proof(key: string, event: NativeEvent, noop?: boolean): void;
    accepted(key: string): void;
    rejected(key: string): void;
    evidence(request: NativeWorkRequest, events: readonly NativeEvent[]): 'accepted' | 'absent' | 'unknown' | 'conflict';
    private save;
}
export declare function queueAdmissionEvent(events: readonly NativeEvent[], cut: number, target: string, message: any): NativeEvent | undefined;
export declare function goalAdmissionEvent(event: NativeEvent, packet: any, noop?: boolean): boolean;
export {};
