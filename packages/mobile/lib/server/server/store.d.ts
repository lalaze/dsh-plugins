import type { Grants, PushPreferences, PushSubscriptionJson } from '../shared/protocol.js';
import { type ExecutorData } from './bridge/executor.js';
import { type VapidKeys } from './push.js';
export interface PhoneRecord {
    id: string;
    /** The phone's X25519 public key, base64url; it authenticates every connection. */
    key: string;
    name: string;
    platform?: string;
    grants: Grants;
    pairedAt: number;
    lastSeen?: number;
    push?: {
        subscription: PushSubscriptionJson;
        preferences: PushPreferences;
        since: number;
    };
}
export interface State {
    version: 1;
    hub: {
        id: string;
        secretKey: string;
        publicKey: string;
    };
    settings: {
        name: string;
        relay: string;
        tls: boolean;
        appUrl: string;
    };
    vapid: VapidKeys;
    phones: Record<string, PhoneRecord>;
    executor: ExecutorData;
}
export declare function newState(defaults?: Partial<State['settings']>): State;
export declare class Store {
    private readonly file;
    readonly state: State;
    private timer?;
    private writing;
    private constructor();
    static open(dir: string, defaults?: Partial<State['settings']>): Promise<Store>;
    /** Write soon; several changes share one write. */
    save(): void;
    flush(): Promise<void>;
}
