'use strict'

// Per-pairing records: what Adhal's RELAY-HOSTS.md §5 asks a relay host to
// show, so the relayed attempts that close before their handshake, and the
// transfers lost mid-file, can be seen from the relay's side. Per pairing:
// when each side's pair request arrived, whether it matched, the first and
// last packet each way, bytes each way, which leg closed first and how, and
// any stream error.
//
// Everything here only watches. blind-relay forwards inside udx-native, and
// nothing below touches a relayed byte or changes what the relay does.
//
// Where the facts come from, in blind-relay 1.6.1 and udx-native:
// - A session's 'pair' event (isInitiator, token, stream) fires on both
//   sessions of a pairing, in one tick, once both legs exist and before
//   either carries a byte.
// - A leg's 'connect' fires when its client's first packet arrives
//   (blind-relay's firewall hook connects the leg to it).
// - A leg's `bytesReceived` and `packetsReceived` count what its client
//   sent, even though the relay forwards it natively: measured 2026-11-18
//   in Adhal's test setup, and checked again by this project's tests. They
//   count UDX packets as they arrive: each packet's 20-byte header, and
//   acks and datagrams as well as stream data. So a leg's first packet is
//   the first sign of its client on it, not necessarily its first byte of
//   data, and a leg whose client only receives still counts its acks. They
//   are polled, every `pollMs`, which is the resolution of the times.
// - A pair request and an unpair are not events in blind-relay's public
//   API. Their arrival is seen by wrapping the session's message handlers
//   (`session._pair.onmessage`, `session._unpair.onmessage`), which call
//   through unchanged. That reaches into blind-relay's internals, so it is
//   checked for on each session, and without it the records still come,
//   less the request times and the requests that never matched.

/** hyperdht's client gives up on a relay pairing after this long (6.36.0, `relayTimeout` in lib/connect.js). */
const CLIENT_RELAY_TIMEOUT_MS = 15000

/** How long the token prefix that names a pairing in the records is, in hex. Enough to tell pairings apart, too short to claim one. */
const PAIRING_ID_HEX = 16

/**
 * @typedef {Record<string, unknown>} LogRecord
 * @typedef {{ code: string | null, message: string }} ErrorInfo
 * @typedef {{
 *   id: number, openedAt: number, address: string | null,
 *   requests: number, duplicates: number, pairings: number,
 *   pending: Set<string>, error: ErrorInfo | null
 * }} SessionInfo
 * @typedef {{ session: SessionInfo, at: number, pairing: string, side: Side }} Request
 * @typedef {'initiator' | 'responder'} Side
 * @typedef {{
 *   side: Side, session: SessionInfo, stream: any, requestedAt: number | null,
 *   connectedAt: number | null, firstPacketAt: number | null, lastPacketAt: number | null,
 *   bytes: number, closedAt: number | null, error: ErrorInfo | null,
 *   address: string | null, host: string | null
 * }} Leg
 * @typedef {{
 *   id: string, token: string, matchedAt: number, legs: Partial<Record<Side, Leg>>,
 *   firstClosed: Side | null, unpairedBy: Side | null, done: boolean
 * }} Pairing
 */

class PairingObserver {
  /**
   * @param {{
   *   stats: any,
   *   write: (record: LogRecord) => void,
   *   includeAddresses?: boolean,
   *   pollMs?: number,
   *   now?: () => number,
   *   onWarning?: (message: string) => void
   * }} options `stats` is the blind-relay server's
   */
  constructor ({ stats, write, includeAddresses = true, pollMs = 100, now = Date.now, onWarning = () => {} }) {
    this._stats = stats
    this._write = write
    this._includeAddresses = includeAddresses
    this._pollMs = pollMs
    this._now = now
    this._onWarning = onWarning
    this._nextSession = 1
    /** @type {Map<string, Request>} pending pair requests, by `${token hex}:${side}` */
    this._pending = new Map()
    /** @type {Map<string, Pairing>} pairings with a leg still open, by token hex */
    this._pairings = new Map()
    /** @type {Set<Leg>} open legs, polled for their counters */
    this._legs = new Set()
    /** @type {NodeJS.Timeout | null} */
    this._timer = null
    this._warnedUntapped = false
    /** @type {Set<() => void>} */
    this._idleWaiters = new Set()
  }

  /** Whether a pairing still has an open leg. */
  get idle () {
    return this._pairings.size === 0
  }

  /**
   * Watch one accepted connection and the blind-relay session on it.
   * @param {any} socket hyperdht's server-side connection
   * @param {any} session what `BlindRelay.Server#accept` returned for it
   */
  watch (socket, session) {
    /** @type {SessionInfo} */
    const info = {
      id: this._nextSession++,
      openedAt: this._now(),
      address: addressOf(socket.rawStream),
      requests: 0,
      duplicates: 0,
      pairings: 0,
      pending: new Set(),
      error: null
    }
    socket.on('error', (/** @type {Error} */ err) => { info.error ??= errorInfo(err) })
    const tapped = this._tap(session, '_pair', (msg, call) => this._onrequest(info, msg, call)) &&
      this._tap(session, '_unpair', (msg, call) => this._onunpair(info, msg, call))
    if (!tapped && !this._warnedUntapped) {
      this._warnedUntapped = true
      this._onWarning('this blind-relay does not expose the message handlers the pairing log watches; records will lack request times and unmatched requests')
    }
    session.on('pair', (/** @type {boolean} */ isInitiator, /** @type {Buffer} */ token, /** @type {any} */ stream) => {
      this._onpaired(info, isInitiator, token, stream)
    })
    session.once('close', () => this._onsessionclose(info))
  }

  /**
   * Wait until every pairing's legs have closed and its record is written,
   * or `timeoutMs` passes; then write what is left, marked as ended by the
   * relay stopping, and stop polling.
   * @param {number} [timeoutMs]
   */
  async close (timeoutMs = 1000) {
    if (!this.idle) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, timeoutMs)
        function done () {
          clearTimeout(timer)
          resolve(undefined)
        }
        this._idleWaiters.add(done)
      })
    }
    const at = this._now()
    for (const pairing of this._pairings.values()) this._finish(pairing, at, true)
    for (const request of this._pending.values()) this._endRequest(request, 'relay-stopped', at)
    this._pending.clear()
    this._stopPolling()
  }

  /**
   * @param {any} session
   * @param {'_pair' | '_unpair'} name
   * @param {(msg: any, call: () => void) => void} handler
   */
  _tap (session, name, handler) {
    const message = session[name]
    if (!message || typeof message.onmessage !== 'function') return false
    const original = message.onmessage
    message.onmessage = function (/** @type {any[]} */ ...args) {
      /** @type {any} */
      let result
      handler(args[0], () => { result = original.apply(this, args) })
      return result
    }
    return true
  }

  /**
   * @param {SessionInfo} info
   * @param {{ isInitiator: boolean, token: Buffer }} msg
   * @param {() => void} call
   */
  _onrequest (info, msg, call) {
    const token = msg.token.toString('hex')
    const side = sideOf(msg.isInitiator)
    const key = `${token}:${side}`
    if (this._pending.has(key)) {
      // blind-relay ignores a second request for a side already waiting.
      info.duplicates++
      call()
      return
    }
    // Recorded before blind-relay sees it: if it completes a pair, the
    // 'pair' events fire inside call(), and they look for it here.
    const requestedBefore = this._stats.pairings.requested
    this._pending.set(key, { session: info, at: this._now(), pairing: token.slice(0, PAIRING_ID_HEX), side })
    info.pending.add(key)
    call()
    if (this._stats.pairings.requested === requestedBefore) {
      // Refused for a reason not modeled here: forget it rather than guess.
      this._pending.delete(key)
      info.pending.delete(key)
      info.duplicates++
      return
    }
    info.requests++
  }

  /**
   * @param {SessionInfo} info
   * @param {{ token: Buffer }} msg
   * @param {() => void} call
   */
  _onunpair (info, msg, call) {
    const token = msg.token.toString('hex')
    const pairing = this._pairings.get(token)
    if (pairing && pairing.unpairedBy === null) {
      // blind-relay ends a matched pairing only for a session with a leg in it.
      for (const leg of Object.values(pairing.legs)) {
        if (leg && leg.session === info) pairing.unpairedBy = leg.side
      }
    }
    const cancelledBefore = this._stats.pairings.cancelled
    call()
    if (this._stats.pairings.cancelled === cancelledBefore) return
    const at = this._now()
    for (const side of /** @type {Side[]} */ (['initiator', 'responder'])) {
      const key = `${token}:${side}`
      const request = this._pending.get(key)
      if (!request) continue
      this._pending.delete(key)
      request.session.pending.delete(key)
      this._endRequest(request, 'unpaired', at, info.id)
    }
  }

  /**
   * @param {SessionInfo} info
   * @param {boolean} isInitiator
   * @param {Buffer} tokenBuffer
   * @param {any} stream
   */
  _onpaired (info, isInitiator, tokenBuffer, stream) {
    const token = tokenBuffer.toString('hex')
    const side = sideOf(isInitiator)
    const at = this._now()
    let pairing = this._pairings.get(token)
    if (pairing && pairing.legs[side]) {
      // The token paired again while a leg of its last pairing is still
      // open: write the old one now, so the new one gets its own record.
      this._finish(pairing, at, false)
      pairing = undefined
    }
    if (!pairing) {
      pairing = {
        id: token.slice(0, PAIRING_ID_HEX),
        token,
        matchedAt: at,
        legs: {},
        firstClosed: null,
        unpairedBy: null,
        done: false
      }
      this._pairings.set(token, pairing)
    }
    const key = `${token}:${side}`
    const request = this._pending.get(key)
    this._pending.delete(key)
    info.pending.delete(key)
    info.pairings++

    /** @type {Leg} */
    const leg = {
      side,
      session: info,
      stream,
      requestedAt: request ? request.at : null,
      connectedAt: null,
      firstPacketAt: null,
      lastPacketAt: null,
      bytes: 0,
      closedAt: null,
      error: null,
      address: null,
      host: null
    }
    pairing.legs[side] = leg
    const onconnect = () => {
      leg.connectedAt ??= this._now()
      leg.host = stream.remoteHost ?? null
      leg.address = stream.remoteHost ? `${stream.remoteHost}:${stream.remotePort}` : null
    }
    if (stream.connected) onconnect()
    else stream.once('connect', onconnect)
    stream.on('error', (/** @type {Error} */ err) => { leg.error ??= errorInfo(err) })
    const owner = pairing
    stream.once('close', () => this._onlegclose(owner, leg))
    this._legs.add(leg)
    this._startPolling()
  }

  /**
   * @param {Pairing} pairing
   * @param {Leg} leg
   */
  _onlegclose (pairing, leg) {
    const at = this._now()
    this._sample(leg, at)
    leg.closedAt = at
    this._legs.delete(leg)
    if (this._legs.size === 0) this._stopPolling()
    if (pairing.done) return
    pairing.firstClosed ??= leg.side
    const { initiator, responder } = pairing.legs
    if (initiator && responder && initiator.closedAt !== null && responder.closedAt !== null) {
      this._finish(pairing, at, false)
    }
  }

  /** @param {SessionInfo} info */
  _onsessionclose (info) {
    const at = this._now()
    // blind-relay cancels a closing session's pending requests.
    for (const key of info.pending) {
      const request = this._pending.get(key)
      this._pending.delete(key)
      if (request) this._endRequest(request, 'session-closed', at)
    }
    info.pending.clear()
    this._write({
      type: 'session',
      session: info.id,
      openedAt: iso(info.openedAt),
      closedAt: iso(at),
      durationMs: at - info.openedAt,
      ...(this._includeAddresses ? { address: info.address } : {}),
      requests: info.requests,
      pairings: info.pairings,
      duplicateRequests: info.duplicates,
      error: info.error
    })
  }

  /**
   * @param {Request} request
   * @param {'unpaired' | 'session-closed' | 'relay-stopped'} outcome
   * @param {number} at
   * @param {number} [by] the session that sent the unpair
   */
  _endRequest (request, outcome, at, by) {
    const pendingMs = at - request.at
    this._write({
      type: 'request',
      pairing: request.pairing,
      side: request.side,
      session: request.session.id,
      requestedAt: iso(request.at),
      outcome,
      ...(by === undefined ? {} : { unpairedBySession: by }),
      pendingMs,
      pastClientTimeout: pendingMs >= CLIENT_RELAY_TIMEOUT_MS
    })
  }

  /**
   * @param {Pairing} pairing
   * @param {number} at
   * @param {boolean} relayStopped
   */
  _finish (pairing, at, relayStopped) {
    if (pairing.done) return
    pairing.done = true
    if (this._pairings.get(pairing.token) === pairing) this._pairings.delete(pairing.token)
    const legs = /** @type {Leg[]} */ ([pairing.legs.initiator, pairing.legs.responder].filter(Boolean))
    for (const leg of legs) {
      if (leg.closedAt === null) this._sample(leg, at)
    }
    const { initiator, responder } = pairing.legs
    this._write({
      type: 'pairing',
      pairing: pairing.id,
      matchedAt: iso(pairing.matchedAt),
      endedAt: iso(at),
      durationMs: at - pairing.matchedAt,
      firstClosed: pairing.firstClosed,
      unpairedBy: pairing.unpairedBy,
      relayStopped,
      sameAddress: initiator && responder && initiator.host !== null && responder.host !== null
        ? initiator.host === responder.host
        : null,
      legs: {
        initiator: initiator ? this._legRecord(initiator, pairing.matchedAt) : null,
        responder: responder ? this._legRecord(responder, pairing.matchedAt) : null
      }
    })
    if (this.idle) {
      for (const done of this._idleWaiters) done()
      this._idleWaiters.clear()
    }
  }

  /**
   * One leg, its times in milliseconds from the match: negative before it.
   * `bytesIn` and `packetsIn` are what this leg's client sent, on the wire,
   * so the initiator leg's are one direction and the responder leg's the
   * other. Only the
   * receive counters are kept: on a natively relayed leg udx-native leaves
   * its transmit, RTT, and retransmit counters at zero (measured on
   * udx-native 1.22.2), and a record of zeros would read as data.
   * @param {Leg} leg
   * @param {number} matchedAt
   */
  _legRecord (leg, matchedAt) {
    const s = leg.stream
    /** @param {number | null} t */
    const rel = (t) => t === null ? null : t - matchedAt
    return {
      session: leg.session.id,
      ...(this._includeAddresses ? { address: leg.address } : {}),
      requestMs: rel(leg.requestedAt),
      connectMs: rel(leg.connectedAt),
      firstPacketInMs: rel(leg.firstPacketAt),
      lastPacketInMs: rel(leg.lastPacketAt),
      closeMs: rel(leg.closedAt),
      bytesIn: counter(s, 'bytesReceived'),
      packetsIn: counter(s, 'packetsReceived'),
      error: leg.error
    }
  }

  /**
   * @param {Leg} leg
   * @param {number} at
   */
  _sample (leg, at) {
    const bytes = counter(leg.stream, 'bytesReceived') ?? 0
    if (bytes > leg.bytes) {
      leg.firstPacketAt ??= at
      leg.lastPacketAt = at
      leg.bytes = bytes
    }
  }

  _startPolling () {
    if (this._timer) return
    this._timer = setInterval(() => {
      const at = this._now()
      for (const leg of this._legs) this._sample(leg, at)
    }, this._pollMs)
    this._timer.unref()
  }

  _stopPolling () {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
  }
}

/** @param {boolean} isInitiator @returns {Side} */
function sideOf (isInitiator) {
  return isInitiator ? 'initiator' : 'responder'
}

/** @param {any} rawStream */
function addressOf (rawStream) {
  if (!rawStream || !rawStream.remoteHost) return null
  return `${rawStream.remoteHost}:${rawStream.remotePort}`
}

/**
 * A udx-native stream counter, or null where this udx-native lacks it. The
 * counters live in memory the stream keeps after it closes, so a closed
 * leg's final values can still be read.
 * @param {any} stream
 * @param {string} name
 * @returns {number | null}
 */
function counter (stream, name) {
  try {
    const value = stream[name]
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

/** @param {Error} err @returns {ErrorInfo} */
function errorInfo (err) {
  return { code: /** @type {any} */ (err).code ?? null, message: err.message }
}

/** @param {number} t */
function iso (t) {
  return new Date(t).toISOString()
}

module.exports = { PairingObserver, CLIENT_RELAY_TIMEOUT_MS, PAIRING_ID_HEX }
