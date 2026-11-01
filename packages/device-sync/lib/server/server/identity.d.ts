export interface Identity {
    readonly deviceId: string;
    /** SPKI DER, base64. */
    readonly publicKey: string;
    sign(data: string): string;
}
/** Device ID of a public key: the first 128 bits of its SHA-256, hex. */
export declare const deviceIdOf: (publicKey: string) => string;
export declare const sha256: (data: string | Uint8Array) => string;
export declare const nonce: () => string;
export declare const defaultDeviceName: () => string;
/** Load the identity at `path`, creating it on first use. The file is readable only by this user. */
export declare function loadIdentity(path: string): Promise<Identity>;
/** Check an Ed25519 signature; malformed keys and signatures are simply invalid. */
export declare function verifySignature(publicKey: string, data: string, signature: string): boolean;
/**
 * The code both users compare when pairing. It covers both public keys and both random nonces, so a machine in the
 * middle that substituted its own key would show different codes on the two screens.
 */
export declare function pairingCode(keyA: string, keyB: string, nonceA: string, nonceB: string): string;
/** What a request signature covers. The body is covered by its hash, the target by its device ID. */
export declare const requestCanonical: (method: string, path: string, from: string, to: string, time: string, id: string, bodyHash: string) => string;
/** What a response signature covers: it answers exactly the request carrying `requestNonce`. */
export declare const responseCanonical: (status: number, requestNonce: string, bodyHash: string) => string;
