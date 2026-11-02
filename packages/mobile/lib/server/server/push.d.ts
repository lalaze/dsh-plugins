import type { PushSubscriptionJson } from '../shared/protocol.js';
export interface VapidKeys {
    /** Uncompressed P-256 public key, base64url: the phone's `applicationServerKey`. */
    publicKey: string;
    /** PKCS #8 private key, base64url. */
    privateKey: string;
}
export declare function generateVapidKeys(): VapidKeys;
/** The `Authorization` header for one push service. */
export declare function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now?: number): string;
/** Encrypt `plaintext` for one subscription as an `aes128gcm` body. `local` and `salt` are fixed only in tests. */
export declare function encryptPayload(subscription: PushSubscriptionJson, plaintext: Uint8Array, local?: {
    privateKey: Buffer;
}, salt?: Buffer): Buffer;
export declare class PushGone extends Error {
    name: string;
}
/** Send one notification. Throws {@link PushGone} when the subscription no longer exists. */
export declare function sendPush(subscription: PushSubscriptionJson, payload: unknown, keys: VapidKeys, options?: {
    subject: string;
    ttl?: number;
    urgency?: 'normal' | 'high';
    topic?: string;
    fetch?: typeof fetch;
}): Promise<void>;
