'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DailyFileSink } = require('../src/log-sink')

/** @param {import('node:test').TestContext} t */
function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sluice-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('records go to a private file per UTC day, one JSON object a line', async (t) => {
  const dir = tempDir(t)
  let now = Date.parse('2026-11-25T23:59:59Z')
  const sink = new DailyFileSink({ dir, retentionDays: 3, now: () => now })
  sink.write({ n: 1 })
  sink.write({ n: 2 })
  now += 2000
  sink.write({ n: 3 })
  await sink.close()

  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['pairings-2026-11-25.jsonl', 'pairings-2026-11-26.jsonl'])
  const lines = (/** @type {string} */ name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepStrictEqual(lines('pairings-2026-11-25.jsonl'), [{ n: 1 }, { n: 2 }])
  assert.deepStrictEqual(lines('pairings-2026-11-26.jsonl'), [{ n: 3 }])
  assert.strictEqual(fs.statSync(path.join(dir, 'pairings-2026-11-26.jsonl')).mode & 0o777, 0o600)
})

test('a day is deleted once it ended more than retentionDays ago, and nothing else is', async (t) => {
  const dir = tempDir(t)
  for (const day of ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']) {
    fs.writeFileSync(path.join(dir, `pairings-${day}.jsonl`), '{}\n')
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
  // 2026-11-22 ended at 2026-11-23T00:00Z, so with 3 days it goes at
  // 2026-11-26T00:00Z and not a moment before.
  let now = Date.parse('2026-11-25T23:59:59Z')
  const sink = new DailyFileSink({ dir, retentionDays: 3, now: () => now })
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'pairings-2026-11-22.jsonl', 'pairings-2026-11-23.jsonl'])
  now = Date.parse('2026-11-26T00:00:00Z')
  sink.prune()
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'pairings-2026-11-23.jsonl'])
  await sink.close()
})

test('retention must be at least a whole day', (t) => {
  const dir = tempDir(t)
  assert.throws(() => new DailyFileSink({ dir, retentionDays: 0 }), RangeError)
  assert.throws(() => new DailyFileSink({ dir, retentionDays: 1.5 }), RangeError)
})
