import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Channel, ChannelError, FRAME_BYTES, hubHandshake, phoneHandshake } from '../src/shared/channel.js'
import { decodeOffer, encodeOffer, pairingCode, type Offer } from '../src/shared/protocol.js'
import { nodeX25519, publicKeyOf } from '../src/server/x25519.js'
import { nobleX25519 } from '../app/src/hub-client.js'

async function pair() {
  const hub = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  const phone = nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  const start = await phoneHandshake(nobleX25519, phone, Buffer.from(hub.publicKey).toString('base64url'))
  const answer = await hubHandshake(nodeX25519, hub, start.hello)
  const phoneKeys = await start.finish(answer.ready)
  const toHub: Uint8Array[] = [], toPhone: Uint8Array[] = []
  return { hub, phone, answer, phoneSide: new Channel(phoneKeys, frame => { toHub.push(frame) }), hubSide: new Channel(answer.keys, frame => { toPhone.push(frame) }), toHub, toPhone }
}

test('node and noble X25519 agree, so the phone and this machine derive the same keys', async () => {
  const { phoneSide, hubSide, toHub, toPhone, answer, phone } = await pair()
  assert.equal(answer.phoneKey, Buffer.from(phone.publicKey).toString('base64url'))
  await phoneSide.send({ id: 1, m: 'hub.info' })
  assert.deepEqual(await hubSide.receive(toHub.shift()!), { id: 1, m: 'hub.info' })
  await hubSide.send({ id: 1, r: { ok: true } })
  assert.deepEqual(await phoneSide.receive(toPhone.shift()!), { id: 1, r: { ok: true } })
})

test('a large message is split into frames and assembled in order', async () => {
  const { phoneSide, hubSide, toPhone } = await pair()
  const text = 'x'.repeat(FRAME_BYTES * 2 + 1234)
  await hubSide.send({ text })
  assert.equal(toPhone.length, 3)
  assert.equal(await phoneSide.receive(toPhone[0]), undefined)
  assert.equal(await phoneSide.receive(toPhone[1]), undefined)
  assert.deepEqual(await phoneSide.receive(toPhone[2]), { text })
})

test('a tampered, repeated or reordered frame is refused', async () => {
  const tampered = await pair()
  await tampered.phoneSide.send({ a: 1 })
  const frame = tampered.toHub.shift()!
  frame[frame.length - 1] ^= 1
  await assert.rejects(tampered.hubSide.receive(frame), ChannelError)

  const repeated = await pair()
  await repeated.phoneSide.send({ a: 1 })
  const first = repeated.toHub.shift()!
  await repeated.hubSide.receive(first)
  await assert.rejects(repeated.hubSide.receive(first), /out of order/)

  const reordered = await pair()
  await reordered.phoneSide.send({ a: 1 }); await reordered.phoneSide.send({ a: 2 })
  await assert.rejects(reordered.hubSide.receive(reordered.toHub[1]), /out of order/)
})

test('a phone that holds the wrong machine key cannot talk to this machine', async () => {
  const hub = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  const impostor = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  const phone = nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  // The phone expects `hub`, but `impostor` answers (as a relay in the middle would).
  const start = await phoneHandshake(nobleX25519, phone, Buffer.from(hub.publicKey).toString('base64url'))
  const answer = await hubHandshake(nodeX25519, impostor, start.hello)
  const phoneKeys = await start.finish(answer.ready)
  const frames: Uint8Array[] = []
  const impostorSide = new Channel(answer.keys, frame => { frames.push(frame) })
  await impostorSide.send({ id: 1, r: {} })
  await assert.rejects(new Channel(phoneKeys, () => {}).receive(frames[0]), /decrypt/)
})

test('a low-order public key is refused', async () => {
  const hub = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  const zero = Buffer.alloc(32).toString('base64url')
  await assert.rejects(hubHandshake(nodeX25519, hub, { t: 'hello', p: 'dsh-mobile/1', key: zero, eph: zero, nonce: Buffer.alloc(16).toString('base64url') }), /Invalid peer key|Invalid/)
})

test('stored keys round-trip, offers encode into a URL fragment, and pairing codes match on both sides', async () => {
  const pairOfKeys = nodeX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array }
  assert.deepEqual(publicKeyOf(pairOfKeys.secretKey), pairOfKeys.publicKey)
  const offer: Offer = { v: 1, server: 'srv_abc', key: 'k', relay: 'relay.example:443', tls: true, token: 't', name: 'Mac 中文', expires: 1 }
  assert.deepEqual(decodeOffer(`https://phone.example/#pair=${encodeOffer(offer)}`), offer)
  assert.throws(() => decodeOffer('https://phone.example/#pair=bm90LWpzb24'))
  const code = await pairingCode('hubkey', 'phonekey', 'token')
  assert.match(code, /^\d{6}$/)
  assert.equal(code, await pairingCode('hubkey', 'phonekey', 'token'))
  assert.notEqual(code, await pairingCode('hubkey', 'otherphone', 'token'))
})
