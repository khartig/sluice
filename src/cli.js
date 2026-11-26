'use strict'

const os = require('node:os')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { loadOrCreateKeyPair, encodeZ32 } = require('./key-pair')
const { startRelay } = require('./relay')
const { DailyFileSink, StreamSink } = require('./log-sink')

const DEFAULT_RETENTION_DAYS = 3

const USAGE = `Usage: sluice [options]

Runs a blind relay over hyperdht, wire-compatible with Pear's
\`pear blind-relay start\`. Clients name it by the public key it prints.

Options:
  --storage <dir>             where the relay's key pair is kept
                              (default: ~/.sluice)
  --print-key                 print the relay's public key and exit
  --port <n>                  UDP port for the DHT node (default: any)
  --host <address>            address to bind the DHT node to
  --bootstrap <host:port,...> DHT bootstrap nodes (default: the public DHT)

Pairing log (off by default; it holds IP addresses and timing):
  --pairing-log <dir | ->     write a record per pairing, request, and
                              session: to a file per UTC day in <dir>, or
                              to stdout with -
  --pairing-log-days <n>      delete a day's file once the day ended more
                              than <n> days ago (default: ${DEFAULT_RETENTION_DAYS})
  --pairing-log-no-addresses  leave IP addresses out of the records

  -h, --help                  show this help
`

/**
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {Promise<number>} the exit status
 */
async function main (argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  /** @type {ReturnType<typeof parse>} */
  let options
  try {
    options = parse(argv)
  } catch (err) {
    stderr.write(`sluice: ${/** @type {Error} */ (err).message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    stdout.write(USAGE)
    return 0
  }

  const { keyPair, created, file } = loadOrCreateKeyPair(options.storage)
  const hex = keyPair.publicKey.toString('hex')
  if (options.printKey) {
    stdout.write(hex + '\n')
    return 0
  }
  if (created) stderr.write(`sluice: created a new key pair in ${file}\n`)

  /** @type {{ write: (record: Record<string, unknown>) => void, close: () => Promise<void> } | null} */
  let sink = null
  if (options.pairingLog === '-') sink = new StreamSink(stdout)
  else if (options.pairingLog) sink = new DailyFileSink({ dir: options.pairingLog, retentionDays: options.retentionDays })

  const relay = await startRelay({
    keyPair,
    bootstrap: options.bootstrap,
    port: options.port,
    host: options.host,
    log: sink,
    includeAddresses: options.includeAddresses,
    onWarning: (message) => stderr.write(`sluice: warning: ${message}\n`)
  })

  const { version } = require('../package.json')
  if (sink) {
    sink.write({
      type: 'relay-start',
      at: new Date().toISOString(),
      version,
      publicKey: hex,
      includeAddresses: options.includeAddresses
    })
  }

  // With the log on stdout, everything for people goes to stderr.
  const say = sink instanceof StreamSink ? stderr : stdout
  say.write([
    'sluice: relay running',
    `  key (hex): ${hex}`,
    `  key (z32): ${encodeZ32(keyPair.publicKey)}`,
    `  pairing log: ${describeLog(options)}`,
    ''
  ].join('\n'))

  await new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      // A second signal while closing ends the process at once.
      process.once('SIGINT', () => process.exit(130))
      process.once('SIGTERM', () => process.exit(143))
      resolve(undefined)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

  say.write('sluice: stopping\n')
  await relay.close()
  const { sessions, pairings } = relay.stats
  if (sink) {
    sink.write({
      type: 'relay-stop',
      at: new Date().toISOString(),
      sessions: { accepted: sessions.accepted, closed: sessions.closed },
      pairings: { requested: pairings.requested, matched: pairings.matched, cancelled: pairings.cancelled }
    })
    await sink.close()
  }
  say.write(`sluice: stopped after ${sessions.accepted} sessions, ${pairings.matched} pairings matched of ${pairings.requested} requests\n`)
  return 0
}

/** @param {string[]} argv */
function parse (argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      storage: { type: 'string' },
      'print-key': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      bootstrap: { type: 'string' },
      'pairing-log': { type: 'string' },
      'pairing-log-days': { type: 'string' },
      'pairing-log-no-addresses': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const retentionDays = values['pairing-log-days'] === undefined
    ? DEFAULT_RETENTION_DAYS
    : wholeNumber(values['pairing-log-days'], '--pairing-log-days', 1)
  return {
    help: values.help === true,
    storage: values.storage ?? path.join(os.homedir(), '.sluice'),
    printKey: values['print-key'] === true,
    port: values.port === undefined ? undefined : wholeNumber(values.port, '--port', 0, 65535),
    host: values.host,
    bootstrap: values.bootstrap === undefined ? undefined : parseBootstrap(values.bootstrap),
    pairingLog: values['pairing-log'],
    retentionDays,
    includeAddresses: values['pairing-log-no-addresses'] !== true
  }
}

/**
 * @param {string} text
 * @param {string} flag
 * @param {number} min
 * @param {number} [max]
 */
function wholeNumber (text, flag, min, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(`${flag} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}, got ${JSON.stringify(text)}`)
  }
  return Number(text)
}

/** @param {string} text */
function parseBootstrap (text) {
  return text.split(',').map((entry) => {
    const at = entry.lastIndexOf(':')
    const host = entry.slice(0, at)
    if (at <= 0 || !host) throw new Error(`--bootstrap takes host:port pairs, got ${JSON.stringify(entry)}`)
    return { host, port: wholeNumber(entry.slice(at + 1), '--bootstrap port', 1, 65535) }
  })
}

/** @param {ReturnType<typeof parse>} options */
function describeLog (options) {
  if (!options.pairingLog) return 'off'
  const what = options.includeAddresses ? 'with addresses' : 'without addresses'
  if (options.pairingLog === '-') return `stdout, ${what}`
  return `${options.pairingLog}, ${what}, kept ${options.retentionDays} days`
}

module.exports = { main, parse }
