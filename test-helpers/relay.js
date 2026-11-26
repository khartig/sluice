'use strict'

const HyperDHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const BlindRelay = require('blind-relay')
const { startRelay } = require('../src/relay')

/**
 * A testnet and a sluice relay on it, with its pairing log collected in
 * `records`. Torn down with the test.
 * @param {import('node:test').TestContext} t
 * @param {{ includeAddresses?: boolean }} [options]
 */
async function relayOnTestnet (t, { includeAddresses = true } = {}) {
  const testnet = await createTestnet(3)
  /** @type {any[]} */
  const records = []
  const relay = await startRelay({
    keyPair: HyperDHT.keyPair(),
    bootstrap: testnet.bootstrap,
    log: { write: (record) => records.push(record) },
    includeAddresses,
    pollMs: 20
  })
  t.after(async () => {
    await relay.close()
    await testnet.destroy()
  })
  return { testnet, relay, records }
}

/**
 * A DHT node that cannot be reached directly, as one behind a NAT that
 * does not punch: what makes hyperdht use the relay it is given.
 * @param {import('node:test').TestContext} t
 * @param {Array<{ host: string, port: number }>} bootstrap
 */
function natNode (t, bootstrap) {
  const dht = new HyperDHT({ bootstrap, ephemeral: true })
  dht.remoteAddress = () => null
  t.after(() => dht.destroy())
  return dht
}

/** hyperdht connect options that rule out every direct path. */
const NO_DIRECT = { holepunch: () => false, localConnection: false, fastOpen: false }

/**
 * One end of a pairing through the relay, without hyperdht's Noise session
 * on top: blind-relay's own client, as hyperdht's relay code drives it, so
 * a test controls exactly what crosses the relay.
 * @param {any} dht
 * @param {Buffer} relayKey
 */
function relayClient (dht, relayKey) {
  const relaySocket = dht.connect(relayKey)
  relaySocket.on('error', () => {})
  const client = BlindRelay.Client.from(relaySocket, { id: relaySocket.publicKey })
  return {
    relaySocket,
    client,
    /**
     * @param {boolean} isInitiator
     * @param {Buffer} token
     * @returns {Promise<any>} the raw stream, connected through the relay
     */
    async pair (isInitiator, token) {
      const stream = dht.createRawStream()
      stream.on('error', () => {})
      /** @type {number} */
      const remoteId = await new Promise((resolve, reject) => {
        client.pair(isInitiator, token, stream).on('error', reject).on('data', resolve)
      })
      const { remotePort, remoteHost, socket } = relaySocket.rawStream
      stream.connect(socket, remoteId, remotePort, remoteHost)
      // A datagram, not stream data: it connects the relay's end of this
      // leg before the first write, so the other side's first bytes have
      // somewhere to go.
      stream.trySend(Buffer.from([0]))
      return stream
    },
    close () { relaySocket.destroy() }
  }
}

/**
 * Resolves once `predicate` holds, polling.
 * @param {() => unknown} predicate
 * @param {number} [timeoutMs]
 */
async function until (predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * @param {any} stream
 * @param {number} length
 */
function readBytes (stream, length) {
  return new Promise((resolve) => {
    let got = 0
    const ondata = (/** @type {Buffer} */ chunk) => {
      got += chunk.length
      if (got >= length) {
        stream.off('data', ondata)
        resolve(got)
      }
    }
    stream.on('data', ondata)
  })
}

module.exports = { relayOnTestnet, natNode, NO_DIRECT, relayClient, until, readBytes, BlindRelay }
