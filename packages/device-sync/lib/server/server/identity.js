/**
 * This machine's device identity: an Ed25519 key pair created on first start and kept only here. The device ID is
 * derived from the public key, so a peer cannot claim another device's ID without its private key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { hostname } from 'node:os';
import { readJson, writeJsonAtomic } from './files.js';
/** Device ID of a public key: the first 128 bits of its SHA-256, hex. */
export const deviceIdOf = (publicKey) => createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32);
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const nonce = () => randomBytes(16).toString('base64url');
export const defaultDeviceName = () => hostname().replace(/\.local$/i, '') || 'DSH';
/** Load the identity at `path`, creating it on first use. The file is readable only by this user. */
export async function loadIdentity(path) {
    let stored = await readJson(path);
    if (stored?.version !== 1 || typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') {
        const pair = generateKeyPairSync('ed25519');
        stored = {
            version: 1,
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
            privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
            createdAt: Date.now(),
        };
        await writeJsonAtomic(path, stored);
    }
    const key = createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const publicKey = stored.publicKey;
    return { deviceId: deviceIdOf(publicKey), publicKey, sign: data => sign(null, Buffer.from(data), key).toString('base64') };
}
const keyCache = new Map();
/** Check an Ed25519 signature; malformed keys and signatures are simply invalid. */
export function verifySignature(publicKey, data, signature) {
    try {
        let key = keyCache.get(publicKey);
        if (!key) {
            key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
            if (key.asymmetricKeyType !== 'ed25519')
                return false;
            if (keyCache.size > 64)
                keyCache.clear();
            keyCache.set(publicKey, key);
        }
        return verify(null, Buffer.from(data), key, Buffer.from(signature, 'base64'));
    }
    catch {
        return false;
    }
}
/**
 * The code both users compare when pairing. It covers both public keys and both random nonces, so a machine in the
 * middle that substituted its own key would show different codes on the two screens.
 */
export function pairingCode(keyA, keyB, nonceA, nonceB) {
    const [first, second] = [keyA, keyB].sort();
    const [n1, n2] = keyA === first ? [nonceA, nonceB] : [nonceB, nonceA];
    const digest = createHash('sha256').update(`dsh-device-sync-pair-v1\n${first}\n${second}\n${n1}\n${n2}`).digest();
    const value = digest.readUInt32BE(0) % 1_000_000;
    return value.toString().padStart(6, '0');
}
/** What a request signature covers. The body is covered by its hash, the target by its device ID. */
export const requestCanonical = (method, path, from, to, time, id, bodyHash) => ['dsh-device-sync-req-v1', method.toUpperCase(), path, from, to, time, id, bodyHash].join('\n');
/** What a response signature covers: it answers exactly the request carrying `requestNonce`. */
export const responseCanonical = (status, requestNonce, bodyHash) => ['dsh-device-sync-res-v1', String(status), requestNonce, bodyHash].join('\n');
