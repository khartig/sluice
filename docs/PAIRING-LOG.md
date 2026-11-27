# The pairing log

What sluice records about the connections it relays, when its operator
turns that on, and what each field means. It exists for the open problems
in Adhal's [RELAY-HOSTS.md](https://github.com/khartig/adhal/blob/main/docs/RELAY-HOSTS.md)
§5: relayed attempts that close before their handshake, and transfers lost
mid-file. Pear's relay reports only totals, so neither can be seen from the
relay's side without it.

## Privacy

**Off by default.** `--pairing-log <dir>` turns it on. The records hold
the IP address and port of every client, and when each one connected,
sent, and left: enough to link the two ends of a drop, and to link a
user's drops by address. Nothing in them is content. The relay cannot see
content, names, or digests, because everything relayed is sealed between
the two peers.

- **Kept briefly.** One file per UTC day, `pairings-YYYY-MM-DD.jsonl`,
  deleted once that day ended more than `--pairing-log-days` days ago
  (default 3). So a record is kept for at least that many days and less
  than one day more. Pruning runs at start, when a new day's file opens,
  and hourly.
- **Private files.** The directory is created `0700`, each file `0600`.
- **`--pairing-log-no-addresses`** leaves addresses out of every record.
  `sameAddress` stays, so a pairing whose two legs share an address (one
  VPN exit, carrier NAT) can still be seen.
- **`--pairing-log -`** writes to stdout instead. Retention is then
  whatever the operator's log collector does.
- **No keys or tokens.** A client's DHT key is fresh for each drop and is
  not logged. A pairing is named by the first 16 hex characters of its
  token: enough to tell pairings apart, too short to claim one, and
  written only after the pairing or request has ended.

## Records

One JSON object per line, each with a `type`. Times are ISO 8601 in UTC,
or milliseconds relative to a pairing's match, negative before it.

### `relay-start`, `relay-stop`

When the relay started and stopped, its version and public key, and at
the stop blind-relay's totals of sessions and pairings.

### `session`: one control connection, written when it closes

A session is one client's encrypted hyperdht connection to the relay, on
which it asks for pairings. Adhal opens one per relay dial.

| Field | Meaning |
| --- | --- |
| `session` | A number, unique while the relay runs, that `pairing` and `request` records refer to |
| `openedAt`, `closedAt`, `durationMs` | When it was accepted and when it closed |
| `address` | The client's address and port, as the relay saw it |
| `requests`, `pairings` | Pair requests it made, and how many matched |
| `duplicateRequests` | Requests blind-relay ignored, because the same side of the same token was already waiting |
| `error` | The connection's first error, `{ code, message }`, or `null` for a clean close |

### `pairing`: two legs relayed to each other, written when both have closed

| Field | Meaning |
| --- | --- |
| `pairing` | The token's first 16 hex characters |
| `matchedAt`, `endedAt`, `durationMs` | When the second request arrived and both legs were created, and when the last leg closed |
| `firstClosed` | `initiator` or `responder`: the leg that closed first |
| `unpairedBy` | The side that ended it with an unpair message, or `null` |
| `relayStopped` | `true` if the relay stopped with a leg still open, so the record was written without its close |
| `sameAddress` | Whether both legs' clients had the same IP address, or `null` if a leg never connected |
| `legs.initiator`, `legs.responder` | One object per leg, below |

Each leg:

| Field | Meaning |
| --- | --- |
| `session` | The session that asked for this leg |
| `address` | The address the client's packets on this leg came from |
| `requestMs` | When this side's pair request arrived. The first side's is negative: how long it waited for the other |
| `connectMs` | When the client's first packet on this leg arrived, which is what connects the leg in blind-relay. `null`: the client never sent one |
| `firstPacketInMs`, `lastPacketInMs` | The first and last time the leg's receive counters were seen to grow |
| `closeMs` | When the leg closed |
| `bytesIn`, `packetsIn` | What this leg's client sent, on the wire. The initiator leg's are one direction of the transfer, the responder leg's the other |
| `error` | How the leg closed: `{ code, message }`, or `null` for a clean close |

How to read them:

- **The counters count UDX packets as they arrive,** 20 bytes of header
  each, acks and datagrams as well as stream data. A leg whose client
  only receives still counts that client's acks, so its `lastPacketInMs`
  says when the acks stopped. In one relayed Adhal drop through sluice,
  a leg's `bytesIn` and `packetsIn` equalled the sending client's own
  `bytesSent` and `packetsSent` exactly (2026-11-25, 3 MB, one machine,
  public DHT).
- **They are polled,** every 100 ms, so `firstPacketInMs` and
  `lastPacketInMs` are good to about that.
- **Only receive counters.** On a natively relayed leg udx-native leaves
  its transmit, RTT, and retransmit counters at zero, so they are not
  recorded.
- **Common errors:** `CHANNEL_CLOSED` means the leg's session closed,
  which ends its legs. `PAIRING_CANCELLED` means an unpair. `ECONNRESET`
  and `ETIMEDOUT` come from UDX itself.
- **blind-relay does not close one leg when the other closes.** A
  pairing's record waits for both. `closeMs` of each leg shows the gap.

### `request`: a pair request that never matched, written when it ends

| Field | Meaning |
| --- | --- |
| `pairing`, `side`, `session`, `requestedAt` | Which request |
| `outcome` | `session-closed`: its session closed first, as hyperdht's client closes it after its 15 s relay timeout. `unpaired`: an unpair canceled it. `relay-stopped` |
| `unpairedBySession` | With `unpaired`: the session that sent the unpair |
| `pendingMs` | How long it waited |
| `pastClientTimeout` | Whether it waited at least 15 s, the point at which hyperdht 6.36.0's client gives up |

blind-relay never expires a waiting request itself. One stays until its
session closes or an unpair arrives.

## How it is observed

The relay is blind-relay's `Server`, unchanged, and nothing here touches a
relayed byte. Most of the record comes from its public API: a session's
`'pair'` event, `'close'`, and `stats`, and each leg's `'connect'`,
`'error'`, `'close'`, and udx-native counters.

Pair requests and unpairs are not events in blind-relay 1.6.1. sluice
sees them by wrapping each session's two message handlers
(`session._pair.onmessage`, `session._unpair.onmessage`). The wrapper
calls the original handler with the same arguments and returns its
result. That reaches into blind-relay's internals, so `src/pairing-log.js`
checks for the handlers on each session. If a later blind-relay lacks
them, sluice warns once and keeps logging, without request times and
without records of requests that never matched. The tests fail if that
happens with the pinned version.
