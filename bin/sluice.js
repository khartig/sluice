#!/usr/bin/env node
'use strict'

require('../src/cli').main(process.argv.slice(2)).then(
  (status) => { process.exitCode = status },
  (err) => {
    process.stderr.write(`sluice: ${err && err.message ? err.message : err}\n`)
    process.exitCode = 1
  }
)
