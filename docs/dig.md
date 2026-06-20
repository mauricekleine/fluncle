# dig fluncle.com — findings over DNS

A finding is a point of light in the Galaxy, and `dig.fluncle.com` is the one you can reach with `dig`. Point a DNS query at a finding's coordinate and the answer comes back as a TXT record: artist, title, BPM, key, the day Fluncle found it, and the link home. No browser, no API client, just the resolver every machine already has.

```
$ dig random.dig.fluncle.com TXT +short
"v=fluncle1; id=012.1.0A; artist=GLXY; title=It's Whatever; album=Pinnacle; bpm=173.48; key=A minor; found=2026-06-11; url=https://www.fluncle.com/log/012.1.0A; spotify=https://open.spotify.com/track/5c1h0scE7Ck8gdRfLvMISZ"
```

This is served by **`fluncle-dns`** (`apps/dns/`), a small authoritative DNS server (Go, [`github.com/miekg/dns`](https://github.com/miekg/dns)) that holds the delegated `dig.fluncle.com` zone and answers each query by reading the public Fluncle API.

## Names you can query

All names live under `dig.fluncle.com`. DNS is case-insensitive, so the coordinate's trailing letter can be upper or lower case.

| Name                          | Answers with                                  |
| ----------------------------- | --------------------------------------------- |
| `<coord>.dig.fluncle.com TXT` | That finding, e.g. `004.7.2I.dig.fluncle.com` |
| `random.dig.fluncle.com TXT`  | A random finding                              |
| `latest.dig.fluncle.com TXT`  | The newest finding                            |
| `dig.fluncle.com SOA` / `NS`  | Zone metadata                                 |

An unknown coordinate returns `NXDOMAIN`. A known name queried for a type other than TXT returns `NOERROR` with no answer (NODATA). Anything outside the zone is `REFUSED` — this server is authoritative for one zone, not a recursive resolver.

```
$ dig 004.7.2I.dig.fluncle.com TXT +short
$ dig latest.dig.fluncle.com TXT +short
$ dig random.dig.fluncle.com TXT +short
$ dig dig.fluncle.com SOA +short
```

## The TXT format

One logical TXT record per finding. The payload is a single line of `key=value` pairs joined by `"; "`. It is built to read cleanly in a terminal and parse cleanly in a script.

```
v=fluncle1; id=011.1.6E; artist=Netsky; title=I See The Future In Your Eyes; album=Second Nature; bpm=171.09; key=C minor; found=2026-06-10; url=https://www.fluncle.com/log/011.1.6E; spotify=https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy
```

Grammar:

- **Version first.** `v=fluncle1` always leads. A parser that does not recognise the version should stop. Bump it on any breaking change to the key set.
- **Keys** are stable and lowercase: `v`, `id`, `artist`, `title`, `album`, `bpm`, `key`, `found`, `url`, `spotify`. Optional fields (`album`, `bpm`, `key`, `spotify`) are omitted when absent; `v`, `id`, `artist`, `title` are always present.
- **`id`** is the finding's Log ID coordinate (e.g. `011.1.6E`). **`found`** is the day Fluncle found it, `YYYY-MM-DD`. **`url`** is the canonical log page.
- **Separator safety.** Values are single-line; a literal `;` inside a value is downgraded to `,` so the `"; "` field separator stays unambiguous.
- **Multiple strings.** A TXT record string maxes out at 255 bytes (RFC 1035). When a payload is longer it is split across several TXT strings on a `"; "` boundary; concatenate the strings (no separator) to get the full payload back, then split on `"; "`.

Parse it in one line:

```bash
dig +short latest.dig.fluncle.com TXT \
  | tr -d '"' | sed 's/" "//g' \
  | tr ';' '\n' | sed 's/^ *//'
```

## Architecture

`fluncle-dns` keeps no database. On each query it reads the public API and renders the result as TXT, with a short in-memory cache so a hot coordinate or a `dig` retry storm does not hammer the API.

- A coordinate or `random` → `GET /api/tracks/<id>` (the stable `/api/*` path is a permanent alias).
- `latest` → `GET /api/tracks?limit=1` (the list is newest-first; the head is the latest finding).

Everything is environment-configurable (see `apps/dns/config.go`):

| Variable                   | Default                   | Meaning                          |
| -------------------------- | ------------------------- | -------------------------------- |
| `FLUNCLE_DNS_LISTEN`       | `:53`                     | UDP+TCP bind address             |
| `FLUNCLE_DNS_ZONE`         | `dig.fluncle.com`         | Authoritative zone               |
| `FLUNCLE_DNS_NS`           | `ns1.dig.fluncle.com`     | Nameserver name (SOA/NS)         |
| `FLUNCLE_DNS_MBOX`         | `hostmaster.fluncle.com`  | SOA admin mailbox                |
| `FLUNCLE_DNS_API_BASE`     | `https://www.fluncle.com` | API origin                       |
| `FLUNCLE_DNS_TTL`          | `300`                     | Answer-record TTL (seconds)      |
| `FLUNCLE_DNS_NEGATIVE_TTL` | `60`                      | SOA minimum / negative-cache TTL |
| `FLUNCLE_DNS_CACHE_TTL`    | `60`                      | In-memory API cache lifetime (s) |
| `FLUNCLE_DNS_API_TIMEOUT`  | `5`                       | Upstream API request timeout (s) |

## Local development

```bash
cd apps/dns
go build ./...
FLUNCLE_DNS_LISTEN=127.0.0.1:15353 go run .
# in another shell:
dig @127.0.0.1 -p 15353 random.dig.fluncle.com TXT +short
dig @127.0.0.1 -p 15353 latest.dig.fluncle.com TXT +short
dig @127.0.0.1 -p 15353 004.7.2I.dig.fluncle.com TXT +short
```

Checks: `gofmt -l . && go vet ./... && go build ./... && go test ./...`.

## Deploying to the rave VPS

`fluncle-dns` runs on the same VPS as `ssh rave.fluncle.com`. Three operator steps: build the binary, install the service, open the port. Then delegate the zone from Cloudflare. These are gated production steps — run them yourself.

### 1. Build and ship the binary

Build a Linux binary and copy it to the VPS:

```bash
cd apps/dns
GOOS=linux GOARCH=amd64 go build -o fluncle-dns .   # match the VPS arch
ssh root@<VPS_IP> 'mkdir -p /opt/fluncle-dns'
scp fluncle-dns root@<VPS_IP>:/opt/fluncle-dns/fluncle-dns
```

### 2. Install the systemd service

`apps/dns/fluncle-dns.service` runs the binary as a hardened, dynamically-allocated user with just `CAP_NET_BIND_SERVICE` so it can bind `:53` without root.

```bash
scp apps/dns/fluncle-dns.service root@<VPS_IP>:/etc/systemd/system/fluncle-dns.service
ssh root@<VPS_IP> 'systemctl daemon-reload && systemctl enable --now fluncle-dns && systemctl status fluncle-dns --no-pager'
```

If `:53` is already taken by a stub resolver (Ubuntu's `systemd-resolved` often holds it), free it first: set `DNSStubListener=no` in `/etc/systemd/resolved.conf`, then `systemctl restart systemd-resolved`. Or point `fluncle-dns` at a different bind address with a drop-in (`systemctl edit fluncle-dns` → `Environment=FLUNCLE_DNS_LISTEN=<VPS_IP>:53`).

### 3. Open port 53 (UDP and TCP)

DNS needs both transports — UDP for the common case, TCP for large answers and fallback.

- **Provider firewall** (Hetzner Cloud firewall, the rave VPS's first gate): allow inbound `UDP/53` and `TCP/53` from anywhere.
- **Host firewall**, if `ufw` is active:

  ```bash
  ssh root@<VPS_IP> 'ufw allow 53/udp && ufw allow 53/tcp'
  ```

### 4. Delegate the zone from Cloudflare

The `fluncle.com` zone lives on Cloudflare. Delegate `dig.fluncle.com` to the VPS by adding two records (both **unproxied / grey cloud** — delegation and glue must point at the real IP):

| Type | Name                  | Content               | Proxy |
| ---- | --------------------- | --------------------- | ----- |
| `NS` | `dig.fluncle.com`     | `ns1.dig.fluncle.com` | off   |
| `A`  | `ns1.dig.fluncle.com` | `<VPS_IP>`            | off   |

The `A` record is the in-bailiwick glue the `NS` delegation points at.

`apps/dns/scripts/delegate.sh` creates both via the Cloudflare API, reading creds from 1Password (`op://Fluncle/Cloudflare DNS/...`). Preview first, then apply:

```bash
apps/dns/scripts/delegate.sh --dry-run <VPS_IP>
apps/dns/scripts/delegate.sh <VPS_IP>
```

The script is idempotent (re-running updates the records in place).

### 5. Verify

```bash
# From anywhere, once delegation propagates:
dig NS dig.fluncle.com +short
dig random.dig.fluncle.com TXT +short

# Or hit the VPS directly before propagation:
dig @<VPS_IP> latest.dig.fluncle.com TXT +short
dig @<VPS_IP> +tcp 004.7.2I.dig.fluncle.com TXT +short
```

When `dig random.dig.fluncle.com TXT` returns a finding from a fresh resolver, the surface is live.
