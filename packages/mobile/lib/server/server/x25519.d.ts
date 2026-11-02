import type { X25519 } from '../shared/channel.js';
export declare const nodeX25519: X25519;
/** The public key of a stored secret key. */
export declare function publicKeyOf(secretKey: Uint8Array): Uint8Array;
