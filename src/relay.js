'use strict'

// The relay: blind-relay's Server on every connection a hyperdht server
// accepts, wired exactly as Pear's `pear blind-relay start` and Adhal's
// test relay (`startRelay` in Adhal's cli/test-helpers/relay.js) wire it,
// so a client cannot tell the three apart (Adhal's RELAY-HOSTS.md §1).
// It sets no limits: every connection is accepted and every pairing
// relayed.

const HyperDHT = require('hyperdht')
const BlindRelay = require('blind-relay')
const { PairingObserver } = require('./pairing-log')

/**
 * @typedef {import('./key-pair').KeyPair} KeyPair
 * @typedef {{ write: (record: Record<string, unknown>) => void }} Sink
 */

/**
 * @param {{
 *   keyPair: KeyPair,
 *   bootstrap?: Array<{ host: string, port: number }>,
 *   port?: number,
 *   host?: string,
 *   log?: Sink | null,
 *   includeAddresses?: boolean,
 *   pollMs?: number,
 *   onWarning?: (message: string) => void
 * }} options `log` turns on the pairing log; without it nothing is recorded
 */
async function startRelay ({ keyPair, bootstrap, port, host, log = null, includeAddresses = true, pollMs, onWarning }) {
  const dht = new HyperDHT({
    ...(bootstrap ? { bootstrap } : {}),
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host })
  })
  const relay = new BlindRelay.Server({
    // framed: hyperdht's secret stream frames its messages, and the relay
    // keeps the packet boundaries it was given.
    createStream: (/** @type {any} */ opts) => dht.createRawStream({ ...opts, framed: true })
  })
  const observer = log
    ? new PairingObserver({ stats: relay.stats, write: (record) => log.write(record), includeAddresses, pollMs, onWarning })
    : null
  const server = dht.createServer((/** @type {any} */ socket) => {
    socket.on('error', () => {})
    // The channel id has to be the client's key: hyperdht's client opens
    // its blind-relay channel with it.
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
    if (observer) observer.watch(socket, session)
  })

  try {
    await server.listen(keyPair)
  } catch (err) {
    await dht.destroy()
    throw err
  }

  let closing = /** @type {Promise<void> | null} */ (null)

  return {
    publicKey: keyPair.publicKey,
    dht,
    stats: relay.stats,
    /** Ends every session, which ends every pairing, and leaves the DHT. */
    close () {
      closing ??= (async () => {
        // blind-relay's own close() waits on sessions that still have a
        // request pending, which may never match: end them all now.
        for (const session of relay.sessions) session.destroy()
        if (observer) await observer.close()
        await server.close()
        await dht.destroy()
      })()
      return closing
    }
  }
}

module.exports = { startRelay }
