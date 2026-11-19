# sluice

A relay host for groups that run their own blind relay: Holepunch's
[blind-relay](https://github.com/holepunchto/blind-relay), the library
Pear's `pear blind-relay start` bundles, with limits and privacy settings
an operator chooses.

Status: design. Nothing is built yet.

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
