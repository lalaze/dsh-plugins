/**
 * The encrypted channel between a phone and this machine, in code both sides run: the phone app in a browser, the
 * plugin in Node. Only X25519 differs between them and is passed in; hashing, key derivation and AES-GCM come from
 * WebCrypto, which both have.
 *
 * Handshake, in plain JSON text frames:
 *   phone → hub  { t: 'hello', p, key: phone static key, eph: phone ephemeral key, nonce }
 *   hub → phone  { t: 'ready', p, eph: hub ephemeral key, nonce }
 * Both derive two AES-256-GCM keys, one per direction, with HKDF-SHA256 over DH(static, static) ‖ DH(ephemeral,
 * ephemeral), salted with a hash of every key and nonce exchanged. The static pair authenticates both ends: the
 * phone took this machine's key from the pairing code, and this machine knows the keys of the phones it paired. The
 * ephemeral pair makes every connection's keys new, so recorded traffic cannot be replayed into a later one.
 *
 * Every later frame is binary: [flags (1)] [counter (8, big-endian)] [ciphertext and tag]. Counters start at 0 and
 * must increase by one, so a dropped, repeated or reordered frame ends the connection. A message larger than one
 * frame is split; flag bit 0 marks a part that more parts follow.
 */
import { base64url, fromBase64url, PROTOCOL } from './protocol.js';
/** Largest plaintext of one frame. Relays commonly accept frames of a few hundred kilobytes or more. */
export const FRAME_BYTES = 192 * 1024;
/** Largest message, assembled from frames. */
export const MESSAGE_BYTES = 24 * 1024 * 1024;
export class ChannelError extends Error {
    name = 'ChannelError';
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};
const key32 = (text, label) => {
    if (typeof text !== 'string')
        throw new ChannelError(`Missing ${label}`);
    let bytes;
    try {
        bytes = fromBase64url(text);
    }
    catch {
        throw new ChannelError(`Invalid ${label}`);
    }
    if (bytes.length !== 32)
        throw new ChannelError(`Invalid ${label}`);
    return bytes;
};
async function sharedSecret(x25519, secretKey, publicKey) {
    let value;
    // OpenSSL refuses a low-order key itself; other implementations return the all-zero secret anyone can compute.
    try {
        value = await x25519.shared(secretKey, publicKey);
    }
    catch {
        throw new ChannelError('Invalid peer key');
    }
    if (value.every(byte => byte === 0))
        throw new ChannelError('Invalid peer key');
    return value;
}
async function deriveKeys(role, ss, ee, t) {
    const salt = new Uint8Array(await subtle().digest('SHA-256', concat(encoder.encode(PROTOCOL), t.hubKey, t.phoneKey, t.hubEph, t.phoneEph, t.phoneNonce, t.hubNonce)));
    const ikm = await subtle().importKey('raw', concat(ss, ee), 'HKDF', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`${PROTOCOL} keys`) }, ikm, 512));
    const aes = (bytes, usage) => subtle().importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
    const phoneToHub = bits.slice(0, 32), hubToPhone = bits.slice(32, 64);
    return role === 'hub'
        ? { send: await aes(hubToPhone, 'encrypt'), receive: await aes(phoneToHub, 'decrypt') }
        : { send: await aes(phoneToHub, 'encrypt'), receive: await aes(hubToPhone, 'decrypt') };
}
/** Seals outgoing messages and opens incoming ones, in order. */
export class Channel {
    keys;
    transmit;
    sent = 0n;
    received = 0n;
    parts = [];
    partBytes = 0;
    sending = Promise.resolve();
    opening = Promise.resolve();
    constructor(keys, transmit) {
        this.keys = keys;
        this.transmit = transmit;
    }
    /** Encrypt and transmit one message. Messages go out in the order of the calls. */
    send(message) {
        const bytes = encoder.encode(JSON.stringify(message));
        if (bytes.length > MESSAGE_BYTES)
            return Promise.reject(new ChannelError('Message too large'));
        const task = this.sending.then(async () => {
            for (let offset = 0; offset < bytes.length || offset === 0; offset += FRAME_BYTES) {
                const part = bytes.subarray(offset, offset + FRAME_BYTES);
                const more = offset + FRAME_BYTES < bytes.length;
                await this.transmit(await this.seal(part, more));
                if (!more)
                    break;
            }
        });
        this.sending = task.catch(() => { });
        return task;
    }
    async seal(plaintext, more) {
        const header = new Uint8Array(9);
        header[0] = more ? 1 : 0;
        new DataView(header.buffer).setBigUint64(1, this.sent++);
        const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv(header), additionalData: header }, this.keys.send, plaintext));
        return concat(header, sealed);
    }
    /** Decrypt one frame; resolves with a message once its last part arrived. Any failure is fatal to the connection. */
    receive(frame) {
        const task = this.opening.then(() => this.open(frame));
        this.opening = task.catch(() => { });
        return task;
    }
    async open(frame) {
        if (frame.length < 9 + 16)
            throw new ChannelError('Frame too short');
        const header = frame.slice(0, 9);
        const counter = new DataView(header.buffer).getBigUint64(1);
        if (counter !== this.received)
            throw new ChannelError('Frame out of order');
        let plaintext;
        try {
            plaintext = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv(header), additionalData: header }, this.keys.receive, frame.slice(9)));
        }
        catch {
            throw new ChannelError('Could not decrypt a frame');
        }
        this.received++;
        this.parts.push(plaintext);
        this.partBytes += plaintext.length;
        if (this.partBytes > MESSAGE_BYTES)
            throw new ChannelError('Message too large');
        if (header[0] & 1)
            return undefined;
        const whole = this.parts.length === 1 ? this.parts[0] : concat(...this.parts);
        this.parts = [];
        this.partBytes = 0;
        try {
            return JSON.parse(decoder.decode(whole));
        }
        catch {
            throw new ChannelError('Invalid message');
        }
    }
}
const iv = (header) => concat(new Uint8Array(4), header.subarray(1, 9));
/** The phone's half of the handshake: the hello to send, then a function finishing it with the hub's ready. */
export async function phoneHandshake(x25519, phone, hubKeyText) {
    const hubKey = key32(hubKeyText, 'machine key');
    const eph = await x25519.generate();
    const phoneNonce = random(16);
    const hello = { t: 'hello', p: PROTOCOL, key: base64url(phone.publicKey), eph: base64url(eph.publicKey), nonce: base64url(phoneNonce) };
    return {
        hello,
        async finish(ready) {
            if (ready?.t !== 'ready' || ready.p !== PROTOCOL)
                throw new ChannelError('This machine speaks another version of the protocol');
            const hubEph = key32(ready.eph, 'machine key'), hubNonce = key32Nonce(ready.nonce);
            const ss = await sharedSecret(x25519, phone.secretKey, hubKey), ee = await sharedSecret(x25519, eph.secretKey, hubEph);
            return deriveKeys('phone', ss, ee, { hubKey, phoneKey: phone.publicKey, hubEph, phoneEph: eph.publicKey, phoneNonce, hubNonce });
        },
    };
}
/** This machine's half: answer a hello. `phoneKey` is the phone's static key, for looking it up. */
export async function hubHandshake(x25519, hub, hello) {
    if (hello?.t !== 'hello')
        throw new ChannelError('Expected a hello');
    if (hello.p !== PROTOCOL)
        throw new ChannelError('The phone app speaks another version of the protocol');
    const phoneKey = key32(hello.key, 'phone key'), phoneEph = key32(hello.eph, 'phone key'), phoneNonce = key32Nonce(hello.nonce);
    const eph = await x25519.generate();
    const hubNonce = random(16);
    const ss = await sharedSecret(x25519, hub.secretKey, phoneKey), ee = await sharedSecret(x25519, eph.secretKey, phoneEph);
    const keys = await deriveKeys('hub', ss, ee, { hubKey: hub.publicKey, phoneKey, hubEph: eph.publicKey, phoneEph, phoneNonce, hubNonce });
    const ready = { t: 'ready', p: PROTOCOL, eph: base64url(eph.publicKey), nonce: base64url(hubNonce) };
    return { ready, keys, phoneKey: hello.key };
}
function key32Nonce(text) {
    if (typeof text !== 'string')
        throw new ChannelError('Missing nonce');
    let bytes;
    try {
        bytes = fromBase64url(text);
    }
    catch {
        throw new ChannelError('Invalid nonce');
    }
    if (bytes.length !== 16)
        throw new ChannelError('Invalid nonce');
    return bytes;
}
