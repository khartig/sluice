'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadOrCreateKeyPair, loadKeyPair, encodeZ32, SEED_FILE } = require('../src/key-pair')

// The z32 package hyperdht depends on, as the reference encoding.
/** @type {{ encode: (b: Buffer) => string }} */
const z32 = require(require.resolve('z32', { paths: [path.dirname(require.resolve('hyperdht'))] }))

/** @param {import('node:test').TestContext} t */
function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sluice-key-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'storage')
}

test('the key pair is created once and the same one loaded after', (t) => {
  const dir = tempDir(t)
  const first = loadOrCreateKeyPair(dir)
  assert.strictEqual(first.created, true)
  assert.strictEqual(first.keyPair.publicKey.length, 32)
  assert.strictEqual(fs.statSync(first.file).mode & 0o777, 0o600)
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)

  const second = loadOrCreateKeyPair(dir)
  assert.strictEqual(second.created, false)
  assert.ok(second.keyPair.publicKey.equals(first.keyPair.publicKey))
  assert.ok(second.keyPair.secretKey.equals(first.keyPair.secretKey))
})

test('a seed file others can read is refused, not used', (t) => {
  const dir = tempDir(t)
  const { file } = loadOrCreateKeyPair(dir)
  fs.chmodSync(file, 0o644)
  assert.throws(() => loadOrCreateKeyPair(dir), /readable by group or others.*chmod 600/)
})

test('a seed file that is not 64 hex characters is refused', (t) => {
  const dir = tempDir(t)
  fs.mkdirSync(dir, { mode: 0o700 })
  fs.writeFileSync(path.join(dir, SEED_FILE), 'not a seed\n', { mode: 0o600 })
  assert.throws(() => loadOrCreateKeyPair(dir), /64 lowercase hex characters/)
})

test('loadKeyPair reads the stored pair and never creates one', (t) => {
  const dir = tempDir(t)
  assert.throws(() => loadKeyPair(dir), /no key pair in .*storage/)
  assert.strictEqual(fs.existsSync(dir), false)

  const created = loadOrCreateKeyPair(dir)
  const loaded = loadKeyPair(dir)
  assert.ok(loaded.keyPair.publicKey.equals(created.keyPair.publicKey))
  assert.ok(loaded.keyPair.secretKey.equals(created.keyPair.secretKey))

  fs.chmodSync(created.file, 0o644)
  assert.throws(() => loadKeyPair(dir), /readable by group or others/)
})

test('z-base-32 matches the z32 package', () => {
  assert.strictEqual(encodeZ32(Buffer.alloc(32)), 'y'.repeat(52))
  for (let i = 0; i < 100; i++) {
    const key = require('node:crypto').randomBytes(32)
    assert.strictEqual(encodeZ32(key), z32.encode(key))
  }
})
