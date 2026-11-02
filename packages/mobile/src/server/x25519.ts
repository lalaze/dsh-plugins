import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'
import type { X25519 } from '../shared/channel.js'

// DER prefixes of a bare 32-byte X25519 key, so raw keys round-trip through node:crypto.
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')

const secretKeyObject = (secretKey: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8, secretKey]), format: 'der', type: 'pkcs8' })

export const nodeX25519: X25519 = {
  generate() {
    const { privateKey, publicKey } = generateKeyPairSync('x25519')
    return {
      secretKey: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length)),
      publicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length)),
    }
  },
  shared(secretKey, publicKey) {
    return new Uint8Array(diffieHellman({ privateKey: secretKeyObject(secretKey), publicKey: createPublicKey({ key: Buffer.concat([SPKI, publicKey]), format: 'der', type: 'spki' }) }))
  },
}

/** The public key of a stored secret key. */
export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return new Uint8Array(createPublicKey(secretKeyObject(secretKey)).export({ format: 'der', type: 'spki' }).subarray(SPKI.length))
}
