'use strict'

// The relay on a hyperdht testnet: that clients relay through it as they do
// through Pear's, and that the pairing log says what happened.

const test = require('node:test')
const assert = require('node:assert')
const HyperDHT = require('hyperdht')
const { relayOnTestnet, natNode, NO_DIRECT, relayClient, until, readBytes, BlindRelay } = require('../test-helpers/relay')
const { PAIRING_ID_HEX } = require('../src/pairing-log')

/** @param {any[]} records @param {string} type */
const ofType = (records, type) => records.filter((r) => r.type === type)

test('hyperdht relays a connection through it, as Adhal does when a punch fails', async (t) => {
  const { testnet, relay, records } = await relayOnTestnet(t)
  const serverNode = natNode(t, testnet.bootstrap)
  const clientNode = natNode(t, testnet.bootstrap)

  const serverKeys = HyperDHT.keyPair()
  const server = serverNode.createServer({ holepunch: () => false, shareLocalAddress: false }, (/** @type {any} */ socket) => {
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  await server.listen(serverKeys)
  t.after(() => server.close())

  const socket = clientNode.connect(serverKeys.publicKey, { ...NO_DIRECT, relayThrough: relay.publicKey })
  socket.on('error', () => {})
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const payload = Buffer.alloc(100_000, 7)
  const echoed = readBytes(socket, payload.length)
  socket.write(payload)
  assert.strictEqual(await echoed, payload.length)

  assert.strictEqual(relay.stats.pairings.matched, 1)
  socket.destroy()
  await until(() => ofType(records, 'pairing').length === 1)

  const [pairing] = ofType(records, 'pairing')
  assert.strictEqual(pairing.pairing.length, PAIRING_ID_HEX)
  for (const side of ['initiator', 'responder']) {
    const leg = pairing.legs[side]
    assert.ok(leg.requestMs <= 0, `${side} asked before the match`)
    assert.ok(leg.connectMs >= 0, `${side} connected its leg`)
    assert.ok(leg.firstPacketInMs >= leg.connectMs, `${side} sent after connecting`)
    // The payload, sealed, framed, and in UDX packets, and the acks for the
    // echo coming back: a little more.
    assert.ok(leg.bytesIn > payload.length, `${side} leg counted ${leg.bytesIn} bytes`)
    assert.match(leg.address, /:\d+$/)
  }
  assert.ok(['initiator', 'responder'].includes(pairing.firstClosed))
  assert.strictEqual(pairing.sameAddress, true)
  assert.strictEqual(pairing.relayStopped, false)
})

test('a pairing record counts each direction separately, natively relayed', async (t) => {
  const { testnet, relay, records } = await relayOnTestnet(t)
  const a = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const b = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const token = BlindRelay.token()

  const [initiator, responder] = await Promise.all([a.pair(true, token), b.pair(false, token)])
  const toResponder = readBytes(responder, 300_000)
  initiator.write(Buffer.alloc(300_000, 1))
  await toResponder
  const toInitiator = readBytes(initiator, 50_000)
  responder.write(Buffer.alloc(50_000, 2))
  await toInitiator

  // The responder's client hangs up first.
  b.close()
  await until(() => records.some((r) => r.type === 'session' && r.pairings === 1))
  a.close()
  await until(() => ofType(records, 'pairing').length === 1)

  const [pairing] = ofType(records, 'pairing')
  const { initiator: i, responder: r } = pairing.legs
  assert.ok(i.bytesIn >= 300_000 && i.bytesIn < 300_000 * 1.1, `initiator sent ${i.bytesIn}`)
  assert.ok(r.bytesIn >= 50_000 && r.bytesIn < 50_000 * 1.2, `responder sent ${r.bytesIn}`)
  // No order between the legs' first packets: each client's first is the
  // datagram that connects its leg, sent by both at once, before any data.
  for (const leg of [i, r]) {
    assert.ok(leg.firstPacketInMs >= leg.connectMs, 'a leg counts nothing before it connects')
    assert.ok(leg.lastPacketInMs >= leg.firstPacketInMs)
  }
  assert.strictEqual(pairing.firstClosed, 'responder')
  assert.ok(r.closeMs <= i.closeMs)
  // blind-relay ends a closing session's legs with this error.
  assert.strictEqual(r.error.code, 'CHANNEL_CLOSED')
  assert.notStrictEqual(r.session, i.session)

  const sessions = ofType(records, 'session')
  assert.strictEqual(sessions.length, 2)
  for (const s of sessions) {
    assert.strictEqual(s.requests, 1)
    assert.strictEqual(s.pairings, 1)
    assert.match(s.address, /:\d+$/)
  }
})

test('a request that never matches is recorded with how it ended', async (t) => {
  const { testnet, relay, records } = await relayOnTestnet(t)
  const node = natNode(t, testnet.bootstrap)

  // Abandoned: its client goes away, as hyperdht's does at its relay timeout.
  const abandoned = relayClient(node, relay.publicKey)
  const lonelyToken = BlindRelay.token()
  abandoned.pair(true, lonelyToken).catch(() => {})
  await until(() => relay.stats.pairings.pending === 1)
  abandoned.close()

  // Canceled: its client unpairs.
  const canceling = relayClient(node, relay.publicKey)
  const canceledToken = BlindRelay.token()
  canceling.pair(false, canceledToken).catch(() => {})
  await until(() => relay.stats.pairings.pending === 1)
  canceling.client.unpair(canceledToken)

  await until(() => ofType(records, 'request').length === 2)
  const byPairing = Object.fromEntries(ofType(records, 'request').map((r) => [r.pairing, r]))

  const gone = byPairing[lonelyToken.toString('hex').slice(0, PAIRING_ID_HEX)]
  assert.strictEqual(gone.outcome, 'session-closed')
  assert.strictEqual(gone.side, 'initiator')
  assert.strictEqual(gone.pastClientTimeout, false)
  assert.ok(gone.pendingMs >= 0)

  const unpaired = byPairing[canceledToken.toString('hex').slice(0, PAIRING_ID_HEX)]
  assert.strictEqual(unpaired.outcome, 'unpaired')
  assert.strictEqual(unpaired.side, 'responder')
  assert.strictEqual(unpaired.unpairedBySession, unpaired.session)
  assert.strictEqual(ofType(records, 'pairing').length, 0)
})

test('an unpair ends a matched pairing, and the record says which side sent it', async (t) => {
  const { testnet, relay, records } = await relayOnTestnet(t)
  const a = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const b = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const token = BlindRelay.token()
  await Promise.all([a.pair(true, token), b.pair(false, token)])

  a.client.unpair(token)
  await until(() => ofType(records, 'pairing').length === 1)
  const [pairing] = ofType(records, 'pairing')
  assert.strictEqual(pairing.unpairedBy, 'initiator')
  assert.strictEqual(pairing.legs.initiator.error.code, 'PAIRING_CANCELLED')
  assert.strictEqual(pairing.legs.responder.error.code, 'PAIRING_CANCELLED')
  // Nobody wrote: each leg saw only the datagram its client connected it with.
  assert.strictEqual(pairing.legs.initiator.packetsIn, 1)
  assert.strictEqual(pairing.legs.responder.packetsIn, 1)
})

test('without addresses, records keep whether the legs shared one and nothing more', async (t) => {
  const { testnet, relay, records } = await relayOnTestnet(t, { includeAddresses: false })
  const a = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const b = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const token = BlindRelay.token()
  await Promise.all([a.pair(true, token), b.pair(false, token)])
  a.close()
  b.close()
  await until(() => ofType(records, 'pairing').length === 1 && ofType(records, 'session').length === 2)

  const text = JSON.stringify(records)
  assert.ok(!/"address"/.test(text), text)
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text), 'no IP address anywhere')
  assert.strictEqual(ofType(records, 'pairing')[0].sameAddress, true)
})

test('stopping the relay ends what is in flight and records it', async (t) => {
  const testnet = await require('hyperdht/testnet')(3)
  t.after(() => testnet.destroy())
  /** @type {any[]} */
  const records = []
  const relay = await require('../src/relay').startRelay({
    keyPair: HyperDHT.keyPair(),
    bootstrap: testnet.bootstrap,
    log: { write: (record) => records.push(record) },
    pollMs: 20
  })
  const a = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const b = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const token = BlindRelay.token()
  await Promise.all([a.pair(true, token), b.pair(false, token)])
  const waiting = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  waiting.pair(true, BlindRelay.token()).catch(() => {})
  await until(() => relay.stats.pairings.pending === 1)

  await relay.close()

  assert.strictEqual(ofType(records, 'pairing').length, 1)
  assert.strictEqual(ofType(records, 'request').length, 1)
  assert.strictEqual(ofType(records, 'request')[0].outcome, 'session-closed')
  assert.strictEqual(ofType(records, 'session').length, 3)
})

test('with no log, the relay records nothing and relays all the same', async (t) => {
  const testnet = await require('hyperdht/testnet')(3)
  const relay = await require('../src/relay').startRelay({ keyPair: HyperDHT.keyPair(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await relay.close()
    await testnet.destroy()
  })
  const a = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const b = relayClient(natNode(t, testnet.bootstrap), relay.publicKey)
  const token = BlindRelay.token()
  const [initiator, responder] = await Promise.all([a.pair(true, token), b.pair(false, token)])
  const got = readBytes(responder, 1000)
  initiator.write(Buffer.alloc(1000))
  assert.strictEqual(await got, 1000)
})
