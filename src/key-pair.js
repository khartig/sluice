'use strict'

// The relay's identity is its hyperdht key pair: every user's `--relay=<key>`
// names the public half, so it has to survive restarts (Adhal's
// RELAY-HOSTS.md §1). It is kept as the 32-byte seed hyperdht derives the
// pair from, in hex, in a file only its owner can read.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const HyperDHT = require('hyperdht')

const SEED_FILE = 'relay-seed'

/**
 * @typedef {{ publicKey: Buffer, secretKey: Buffer }} KeyPair
 */

/**
 * The key pair stored in `dir`, created on first use.
 *
 * Refuses a seed file that group or others can read, as ssh does with a
 * private key: whoever holds the seed can run a relay under this key.
 *
 * @param {string} dir
 * @returns {{ keyPair: KeyPair, created: boolean, file: string }}
 */
function loadOrCreateKeyPair (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, SEED_FILE)
  let created = false
  /** @type {string} */
  let text
  try {
    text = readPrivate(file)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    const seed = crypto.randomBytes(32)
    // wx: never overwrite a seed that appeared since the read above.
    fs.writeFileSync(file, seed.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
    created = true
    text = readPrivate(file)
  }
  const hex = text.trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${file} must hold the relay's 32-byte seed as 64 lowercase hex characters`)
  }
  return { keyPair: HyperDHT.keyPair(Buffer.from(hex, 'hex')), created, file }
}

/** @param {string} file */
function readPrivate (file) {
  const fd = fs.openSync(file, 'r')
  try {
    const { mode } = fs.fstatSync(fd)
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by group or others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${file}`)
    }
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

/**
 * z-base-32, the spelling hypercore-id-encoding and most Holepunch tooling
 * print a key in. Adhal accepts it and hex (`parseRelayKey`).
 * @param {Buffer} bytes
 */
function encodeZ32 (bytes) {
  let out = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += Z32_ALPHABET[(value >>> bits) & 31]
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += Z32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

module.exports = { loadOrCreateKeyPair, encodeZ32, SEED_FILE }
