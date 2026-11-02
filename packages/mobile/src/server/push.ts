/**
 * Web Push from this machine straight to a phone's push service (Apple, Google, Mozilla), with no server of our own:
 * VAPID (RFC 8292) identifies this machine, and the message is encrypted for the phone's browser (RFC 8291,
 * `aes128gcm`), so the push service cannot read it.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'
import type { PushSubscriptionJson } from '../shared/protocol.js'

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: the phone's `applicationServerKey`. */
  publicKey: string
  /** PKCS #8 private key, base64url. */
  privateKey: string
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  return { publicKey: b64url(raw), privateKey: b64url(privateKey.export({ format: 'der', type: 'pkcs8' })) }
}

/** The `Authorization` header for one push service. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const key = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`
}

/** Encrypt `plaintext` for one subscription as an `aes128gcm` body. `local` and `salt` are fixed only in tests. */
export function encryptPayload(subscription: PushSubscriptionJson, plaintext: Uint8Array, local?: { privateKey: Buffer }, salt: Buffer = randomBytes(16)): Buffer {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url'), authSecret = Buffer.from(subscription.keys.auth, 'base64url')
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid push subscription keys')
  const ecdh = createECDH('prime256v1')
  if (local) ecdh.setPrivateKey(local.privateKey); else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // One record: the payload followed by the last-record delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4); recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body])
}

export class PushGone extends Error { override name = 'PushGone' }

/** Send one notification. Throws {@link PushGone} when the subscription no longer exists. */
export async function sendPush(subscription: PushSubscriptionJson, payload: unknown, keys: VapidKeys, options: { subject: string; ttl?: number; urgency?: 'normal' | 'high'; topic?: string; fetch?: typeof fetch } = { subject: 'mailto:dsh-mobile@localhost' }): Promise<void> {
  const endpoint = new URL(subscription.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('Push endpoints must use HTTPS')
  const body = encryptPayload(subscription, new TextEncoder().encode(JSON.stringify(payload)))
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, keys, options.subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl ?? 24 * 3600), Urgency: options.urgency ?? 'normal',
      ...(options.topic ? { Topic: options.topic } : {}),
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404 || response.status === 410) throw new PushGone(`The push subscription expired (HTTP ${response.status})`)
  if (!response.ok) throw new Error(`The push service refused the notification (HTTP ${response.status}${await response.text().then(text => text ? `: ${text.slice(0, 200)}` : '', () => '')})`)
}
