'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const createTestnet = require('hyperdht/testnet')
const { natNode, relayClient, until, readBytes, BlindRelay } = require('../test-helpers/relay')
const { encodeZ32 } = require('../src/key-pair')

const BIN = path.join(__dirname, '..', 'bin', 'sluice.js')

/** @param {import('node:test').TestContext} t */
function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sluice-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the relay runs under its stored key, relays, logs, and stops cleanly on SIGTERM', async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const dir = tempDir(t)
  const storage = path.join(dir, 'storage')
  const logDir = path.join(dir, 'log')
  const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')

  const child = spawn(process.execPath, [BIN, '--storage', storage, '--bootstrap', bootstrap, '--pairing-log', logDir], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  await until(() => /key \(z32\)/.test(stdout), 15000)

  const hex = /** @type {RegExpExecArray} */ (/key \(hex\): ([0-9a-f]{64})/.exec(stdout))[1]
  const key = Buffer.from(hex, 'hex')
  assert.match(stdout, new RegExp(`key \\(z32\\): ${encodeZ32(key)}`))
  assert.match(stderr, /created a new key pair/)
  assert.match(stdout, /pairing log: .*log, with addresses, kept 3 days/)
  // The same key on the next start: what keeps users' --relay= working.
  assert.strictEqual(execFileSync(process.execPath, [BIN, '--storage', storage, '--print-key'], { encoding: 'utf8' }).trim(), hex)

  const a = relayClient(natNode(t, testnet.bootstrap), key)
  const b = relayClient(natNode(t, testnet.bootstrap), key)
  const token = BlindRelay.token()
  const [initiator, responder] = await Promise.all([a.pair(true, token), b.pair(false, token)])
  const got = readBytes(responder, 10_000)
  initiator.write(Buffer.alloc(10_000))
  assert.strictEqual(await got, 10_000)
  a.close()
  b.close()

  // Let the pairing's legs close before the relay does.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  assert.deepStrictEqual(await exited, { code: 0, signal: null })
  assert.match(stdout, /stopped after 2 sessions, 1 pairings matched of 2 requests/)

  const files = fs.readdirSync(logDir)
  assert.strictEqual(files.length, 1)
  assert.match(files[0], /^pairings-\d{4}-\d{2}-\d{2}\.jsonl$/)
  assert.strictEqual(fs.statSync(path.join(logDir, files[0])).mode & 0o777, 0o600)
  const records = fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const types = records.map((r) => r.type)
  assert.strictEqual(types.shift(), 'relay-start')
  assert.strictEqual(types.pop(), 'relay-stop')
  // Sessions and their pairing are written as each ends, so in either order.
  assert.deepStrictEqual(types.sort(), ['pairing', 'session', 'session'])
  assert.strictEqual(records[0].publicKey, hex)
  const pairing = records.find((r) => r.type === 'pairing')
  assert.ok(pairing.legs.initiator.bytesIn >= 10_000)
})

test('a bad option is a usage error, with exit status 2', () => {
  let status = 0
  let stderr = ''
  try {
    execFileSync(process.execPath, [BIN, '--port', 'many'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    status = /** @type {any} */ (err).status
    stderr = /** @type {any} */ (err).stderr
  }
  assert.strictEqual(status, 2)
  assert.match(stderr, /--port must be a whole number from 0 to 65535/)
  assert.match(stderr, /Usage: sluice/)
})
