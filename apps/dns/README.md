# dns

Fluncle's authoritative DNS server: a small Go daemon ([`github.com/miekg/dns`](https://github.com/miekg/dns)) that holds the delegated `dig.fluncle.com` zone and answers each query by reading the public Fluncle API. `dig <coordinate>.dig.fluncle.com TXT` returns that finding as a TXT record — artist, title, BPM, key, the day Fluncle found it, the link home — plus the reserved `random`, `latest`, and `live` labels.

It is a leaf zone and nothing more: no recursion (an out-of-zone question is REFUSED), no secondaries, no zone file. Every answer is minted per query from a short-lived in-memory cache over the API, so the archive is the only source of truth.

- **What it serves, and the names you can query:** [docs/dig.md](../../docs/dig.md) — the surface doc, including the TXT record format and the `v=fluncle1` field list.
- **Runtime knobs:** `loadConfig()` in [config.go](./config.go) — every `FLUNCLE_DNS_*` environment key with its default (zone, NS, mailbox, listen address, API origin, the TTLs, the cache and upstream timeouts), so the systemd unit ([fluncle-dns.service](./fluncle-dns.service)) can retarget the binary without a rebuild.
- **Delegation:** [scripts/delegate.sh](./scripts/delegate.sh) — creates the two Cloudflare records that hand the zone over (the `NS` delegation + the in-bailiwick `A` glue, both unproxied).

Checks: `go build -C apps/dns ./...`, `gofmt -l apps/dns` (must list nothing), `go vet -C apps/dns ./...`.
