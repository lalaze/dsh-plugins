export interface X25519 {
    /** A new key pair: 32-byte secret and public keys. */
    generate(): {
        secretKey: Uint8Array;
        publicKey: Uint8Array;
    } | Promise<{
        secretKey: Uint8Array;
        publicKey: Uint8Array;
    }>;
    /** The shared secret of `secretKey` and `publicKey`. */
    shared(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
export interface Hello {
    t: 'hello';
    p: string;
    key: string;
    eph: string;
    nonce: string;
}
export interface Ready {
    t: 'ready';
    p: string;
    eph: string;
    nonce: string;
}
/** Largest plaintext of one frame. Relays commonly accept frames of a few hundred kilobytes or more. */
export declare const FRAME_BYTES: number;
/** Largest message, assembled from frames. */
export declare const MESSAGE_BYTES: number;
export declare class ChannelError extends Error {
    name: string;
}
/** Seals outgoing messages and opens incoming ones, in order. */
export declare class Channel {
    private readonly keys;
    private readonly transmit;
    private sent;
    private received;
    private parts;
    private partBytes;
    private sending;
    private opening;
    constructor(keys: {
        send: CryptoKey;
        receive: CryptoKey;
    }, transmit: (frame: Uint8Array) => void | Promise<void>);
    /** Encrypt and transmit one message. Messages go out in the order of the calls. */
    send(message: unknown): Promise<void>;
    private seal;
    /** Decrypt one frame; resolves with a message once its last part arrived. Any failure is fatal to the connection. */
    receive(frame: Uint8Array): Promise<unknown | undefined>;
    private open;
}
/** The phone's half of the handshake: the hello to send, then a function finishing it with the hub's ready. */
export declare function phoneHandshake(x25519: X25519, phone: {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
}, hubKeyText: string): Promise<{
    hello: Hello;
    finish(ready: Ready): Promise<{
        send: CryptoKey;
        receive: CryptoKey;
    }>;
}>;
/** This machine's half: answer a hello. `phoneKey` is the phone's static key, for looking it up. */
export declare function hubHandshake(x25519: X25519, hub: {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
}, hello: Hello): Promise<{
    ready: Ready;
    keys: {
        send: CryptoKey;
        receive: CryptoKey;
    };
    phoneKey: string;
}>;
