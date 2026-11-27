# sluice

A relay host for groups that run their own blind relay: Holepunch's
[blind-relay](https://github.com/holepunchto/blind-relay), the library
Pear's `pear blind-relay start` bundles, with limits and privacy settings
an operator chooses.

Status: first version. A wire-compatible relay with an opt-in log of
each pairing, and no limits yet.

## Why it exists

sluice was split out of [Adhal](https://github.com/khartig/adhal), a
peer-to-peer file drop. When a hole punch fails, Adhal can connect two
peers through a relay the user names (`--relay=<key>`). Adhal stays
relay-agnostic: it takes a relay's key and works with any server that
speaks blind-relay over hyperdht. Pear's own relay is one, and sluice is
another, wire-compatible with it.

Pear's relay has no limits: no caps on bandwidth, duration, or
connections, and no allowlist. Each of those trades privacy against
abuse. Caps per token are easy to get around, because every connection
brings a fresh token, so meaningful caps count per IP address or per
credential, and that lets the operator link a user's connections. Adhal
leaves that trade to whoever runs the relay
([Adhal's THREAT-MODEL.md](https://github.com/khartig/adhal/blob/main/docs/THREAT-MODEL.md)
§8, and its [IMPLEMENTATION-PLAN.md](https://github.com/khartig/adhal/blob/main/docs/IMPLEMENTATION-PLAN.md)
§3). sluice is where that trade gets made, by the group that runs it.

## What it builds on

- blind-relay's `Server` and its pairing protocol, unchanged, with the
  native forwarding it already does.
- hyperdht's server, including its `firewall` hook, for refusing
  connections.
- The counters udx-native keeps on each relayed stream. Measured on
  2026-11-18 in Adhal's test setup: a relay-side stream's
  `bytesReceived` counts what blind-relay forwards natively, so limits
  on bytes and duration need no forwarding in JavaScript.

Nothing in Pear is patched or extended.

## Running it

Node 24 or later. sluice is published to npm as `sluice-relay`, and
installs a `sluice` command:

```sh
npm install --global sluice-relay
sluice                                  # relay on the public DHT
sluice --pairing-log ./pairing-log      # and log each pairing
```

From a clone, `pnpm install --frozen-lockfile` and then
`node bin/sluice.js` does the same.

It prints its public key, in hex and in z-base-32. Clients name the
relay by that key: Adhal's `--relay=<key>`. The key pair is created on
first run in `~/.sluice` (`--storage` to change it) and reused after, so
the key stays the same across restarts. Its seed file must stay readable
only by its owner. `sluice --print-key` prints the key and exits; it
reads the key pair in `--storage` and fails if there is none, rather
than create one.
`--port` fixes the DHT node's UDP port, for a firewall rule.

SIGINT or SIGTERM stops it: every session is ended, the log is flushed,
and blind-relay's totals are printed.

## What it does now

- **The relay.** Every connection gets blind-relay's `Server`, wired as
  Pear's relay wires it (Adhal's
  [RELAY-HOSTS.md](https://github.com/khartig/adhal/blob/main/docs/RELAY-HOSTS.md)
  §1). There are no caps and no allowlist: every connection is accepted
  and every pairing relayed.
- **The pairing log,** off by default: one record per pairing, per
  unmatched request, and per session, with times, byte counts, which leg
  closed first, and how. What it holds, how long it is kept, and what
  each field means is in [docs/PAIRING-LOG.md](docs/PAIRING-LOG.md).

## Development

```sh
pnpm test        # node --test, on a local hyperdht testnet
pnpm typecheck   # tsc --noEmit over the JSDoc types
```

Dependencies are pinned exactly, and CI fails on any advisory that
`pnpm audit` or OSV-Scanner reports:
[docs/DEPENDENCY-POLICY.md](docs/DEPENDENCY-POLICY.md). hyperdht 6.36.0
and blind-relay 1.6.1 are the versions Adhal and Pear use. The lockfile
has one blind-relay, shared with hyperdht.

- [docs/DEPLOYING.md](docs/DEPLOYING.md): a systemd service on a Linux
  server, next to Pear's relay if one is running there.
- [docs/RELEASING.md](docs/RELEASING.md): publishing to npm, with
  provenance, from a GitHub Release.
