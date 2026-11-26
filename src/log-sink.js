'use strict'

// Where pairing records go: one JSON object per line. The records hold IP
// addresses and timing, so they are kept briefly (Adhal's RELAY-HOSTS.md
// §5): a file per UTC day, `pairings-YYYY-MM-DD.jsonl`, readable only by its
// owner, deleted once the day it covers ended more than `retentionDays` ago.
// A record is so kept for at least `retentionDays` and less than one day
// more.

const fs = require('node:fs')
const path = require('node:path')

const FILE_PATTERN = /^pairings-(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

class DailyFileSink {
  /**
   * @param {{ dir: string, retentionDays: number, now?: () => number }} options
   */
  constructor ({ dir, retentionDays, now = Date.now }) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new RangeError('retentionDays must be a whole number of days, at least 1')
    }
    this.dir = dir
    this.retentionDays = retentionDays
    this._now = now
    /** @type {string | null} */
    this._day = null
    /** @type {fs.WriteStream | null} */
    this._out = null
    /** @type {Promise<void>[]} streams still flushing */
    this._ending = []
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.prune()
    this._pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS)
    this._pruneTimer.unref()
  }

  /** @param {Record<string, unknown>} record */
  write (record) {
    const day = dayOf(this._now())
    if (day !== this._day) {
      this._endCurrent()
      this._day = day
      this._out = fs.createWriteStream(path.join(this.dir, `pairings-${day}.jsonl`), { flags: 'a', mode: 0o600 })
      this._out.on('error', () => {})
      this.prune()
    }
    /** @type {fs.WriteStream} */ (this._out).write(JSON.stringify(record) + '\n')
  }

  /** Delete the files whose day ended more than `retentionDays` ago. */
  prune () {
    const cutoff = this._now() - this.retentionDays * DAY_MS
    /** @type {string[]} */
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const match = FILE_PATTERN.exec(name)
      if (!match) continue
      const dayEnds = Date.parse(`${match[1]}T00:00:00Z`) + DAY_MS
      if (dayEnds <= cutoff) fs.rmSync(path.join(this.dir, name), { force: true })
    }
  }

  async close () {
    clearInterval(this._pruneTimer)
    this._endCurrent()
    await Promise.all(this._ending)
  }

  _endCurrent () {
    const out = this._out
    if (!out) return
    this._out = null
    this._ending.push(new Promise((resolve) => out.end(resolve)))
  }
}

/** Writes to a stream the caller owns, such as stdout, and keeps nothing. */
class StreamSink {
  /** @param {NodeJS.WritableStream} out */
  constructor (out) {
    this._out = out
  }

  /** @param {Record<string, unknown>} record */
  write (record) {
    this._out.write(JSON.stringify(record) + '\n')
  }

  async close () {}
}

/** @param {number} t */
function dayOf (t) {
  return new Date(t).toISOString().slice(0, 10)
}

module.exports = { DailyFileSink, StreamSink, FILE_PATTERN }
