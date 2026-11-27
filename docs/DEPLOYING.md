# Deploying sluice

How to run sluice on a Linux server as a systemd service, including on a
machine that already runs Pear's relay.

## Install

sluice needs Node 24 or later. Install it from your distribution or
NodeSource, then:

```sh
sudo npm install --global sluice-relay
command -v sluice    # where the service's ExecStart should point
```

To upgrade, run `sudo npm install --global sluice-relay@<version>` and
then `sudo systemctl restart sluice`. The key pair lives in the storage
directory, not in the package, so the relay's key survives upgrades.

## Next to Pear's relay

Two relays on one machine do not conflict. Each one:

- **has its own key.** Pear derives its key from its corestore, and
  sluice keeps its own in `--storage`. Clients choose between them by
  key, so `--relay=<sluice's key>` reaches sluice and Pear's key still
  reaches Pear.
- **runs its own DHT node on its own UDP port.** Give sluice a fixed
  port with `--port`, different from Pear's, and open that port for UDP.

To compare them, run the same drops through each relay from the same
two machines: Adhal's `tools/cli-trials-run.sh` with `-- --relay <key>`
(Adhal's RELAY-HOSTS.md §6). The difference between the runs is then
the relay. With the pairing log on, sluice also records what Pear's
relay cannot show: where a relayed attempt dies.

## A systemd service

Create a user with no login shell, and a unit that runs sluice as that
user:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin sluice
```

`/etc/systemd/system/sluice.service`:

```ini
[Unit]
Description=sluice blind relay
After=network-online.target
Wants=network-online.target

[Service]
User=sluice
Group=sluice
# /var/lib/sluice for the key pair, /var/log/sluice for the pairing log,
# both created by systemd and owned by the sluice user.
StateDirectory=sluice
StateDirectoryMode=0700
LogsDirectory=sluice
LogsDirectoryMode=0700
ExecStart=/usr/bin/sluice --storage /var/lib/sluice --port 49738 \
  --pairing-log /var/log/sluice --pairing-log-days 3
Restart=on-failure
RestartSec=5
# SIGTERM ends every session and flushes the log; give it a moment.
TimeoutStopSec=15

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
# AF_NETLINK: the DHT node lists the network interfaces at startup, which
# on Linux takes a netlink socket. Without it sluice exits with "address
# family not supported".
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
```

Point `ExecStart` at what `command -v sluice` printed, and pick any
free port. Leave out the `--pairing-log` options to run without the log.
That is the default, and the log holds client IP addresses
([PAIRING-LOG.md](PAIRING-LOG.md)).

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sluice
journalctl -u sluice -n 20           # prints the relay's key
sudo -u sluice sluice --storage /var/lib/sluice --print-key
```

## Firewall

The relay needs UDP in on its `--port`. With ufw:

```sh
sudo ufw allow 49738/udp
```

On DigitalOcean, if the droplet has a cloud firewall, add an inbound
UDP rule for the same port too. Nothing else needs to be open: clients
reach the relay over the DHT, and the relayed streams use the same UDP
socket.

To check it from a client machine, use Adhal's probe:
`node engine/scratch-relay-probe.js <key> --expect=<server's IP address>`
prints `ok: true` when the key is announced and UDP gets through.

## Back up the key

`/var/lib/sluice/relay-seed` is the relay's identity. If it is lost, the
relay comes back under a new key, and every user's `--relay=` stops
working. Back it up somewhere only you can read. Anyone holding it can
run a relay under the same key.
