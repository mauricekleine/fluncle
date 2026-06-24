# fluncle-rave-watchdog

The rave-01 side of Fluncle's monitoring dead-man's switch. A small bash watchdog + a hardened systemd timer that runs ON rave-01 (the public-edge box — the SSH terminal in [`apps/ssh/`](../), the dig DNS server in [`apps/dns/`](../../dns/), and the Tor onion services) every ~10 minutes. rave-01 otherwise runs only `Restart=always` services; this timer is its sole periodic job.

## What it does

Each run does three best-effort jobs and always exits 0 on a completed run:

1. **rave-01's own beacon.** It `curl`s `$RAVE01_BEACON_URL` — rave-01's external dead-man's-switch ping. An outside uptime service alerts when these pings _stop_, which catches **rave-01 itself going dark**.
2. **The rave-01→rave-02 cross-ping.** It reads `$WATCH_STATUS_URL` (the public [`/api/status`](../../web/src/routes/api/status.ts)) and pulls the single integer `secondsSinceProberReport` (the staleness of the `hermes` service — the rave-02 healthcheck cron's self-liveness, posted **only** by that cron, so job 3's own onion post can't mask it). If that exceeds `$WATCH_STALE_MINUTES × 60` (default 30 min), the rave-02 prober has gone dark, so it Discord-pings `$DISCORD_ALERT_WEBHOOK` — but **only once on the flip into-stale and once on recovery**, using a transition-state file (`watchdog-state.json` under the systemd `StateDirectory`), the same no-spam pattern as the `fluncle-healthcheck` cron. If `/api/status` is unreachable, it logs to stderr and **skips** the freshness check this round (it does **not** alert on web-unreachable — that is the healthcheck cron's job, and the external beacons cover a systemic outage). It never throws.
3. **The onion probe.** rave-01 hosts the Tor onion services and runs Tor, so it is the only box that can route a `.onion` request. It `curl --socks5-hostname`s the onion (`$WATCH_ONION_URL`) through rave-01's local Tor SOCKS proxy: **any HTTP response = reachable** (the onion service is published _and_ the Tor circuit + onionspray + the Worker all answered — even the Worker's http→https 307 proves the path); a timeout/refusal = down. It then POSTs an `onion` service check to `record_health` (`$WATCH_WORKER_URL/api/admin/health`, authorized by `$FLUNCLE_API_TOKEN`), so the onion shows on `/status` like any other service, and Discord-pings on a transition (a separate `onion-state.json`), no-spam. All four onion vars are optional — unset any and the probe is skipped. (This is why the cross-ping reads `secondsSinceProberReport`, not the global freshest: rave-01 now posts to `record_health` too, and keying the cross-ping on `hermes` keeps rave-01's onion post from ever masking a dead rave-02.)

## Architecture: the dead-man's-switch triad

A monitoring stack has to answer "who watches the watcher?" Fluncle's answer is three independent legs, no single point of failure:

| Leg                            | Lives in                                                                                                                                                         | Catches                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **rave-02 beacon**             | `HEALTHCHECK_BEACON_URL` in [`fluncle-healthcheck.ts`](../../../docs/agents/hermes/scripts/fluncle-healthcheck.ts) — pinged at the end of every healthcheck tick | rave-02 (the prober) going dark — a dead prober can't alert about itself                                             |
| **rave-01 beacon**             | `RAVE01_BEACON_URL` in this watchdog — pinged every run                                                                                                          | rave-01 (the public edge) going dark                                                                                 |
| **rave-01→rave-02 cross-ping** | `WATCH_STATUS_URL` in this watchdog — reads the public `/api/status` freshness                                                                                   | the rave-02 prober going dark, _on-box and fast_ (a Discord ping within ~10m, no external-service grace-period wait) |

The cross-ping and the rave-02 beacon both catch a dead prober; together they give a fast on-box alert **and** an out-of-band one. The crucial gap only the **external beacon service** closes: if **BOTH boxes are down**, no on-box job can run — neither beacon pings, neither cron ticks, the cross-ping can't execute. The external uptime service is then the **only** thing left to alert (it fires because the pings stopped). That systemic catch is the entire reason the beacons exist; the on-box cross-ping is the fast, fine-grained complement.

## Env keys (names only — values live in the ops runbook note in 1Password)

Public-safe by construction (this repo is open source): NO hostnames, IPs, ports, URLs, `op://` paths, webhooks, or tailnet names appear in any committed file here. Every input is read from an operator-placed `EnvironmentFile` kept out of the repo (the unit points at `/etc/fluncle/rave-watchdog.env`).

- `RAVE01_BEACON_URL` — rave-01's external dead-man's-switch beacon URL (silent liveness ping).
- `WATCH_STATUS_URL` — the public `/api/status` URL (the cross-ping freshness source).
- `WATCH_STALE_MINUTES` — _optional_; the staleness threshold in minutes (default 30).
- `DISCORD_ALERT_WEBHOOK` — the Discord webhook for the transition alerts.
- `WATCH_ONION_URL` — _optional_ (job 3); the onion health URL (`http://<addr>.onion/api/health`). Unset skips the onion probe.
- `WATCH_WORKER_URL` — the Worker origin for the onion `record_health` POST (e.g. the public site origin).
- `FLUNCLE_API_TOKEN` — the agent-scoped token authorizing the onion POST (`record_health` is agent-tier).
- `WATCH_TOR_SOCKS` / `WATCH_ONION_TIMEOUT` — _optional_; rave-01's Tor SOCKS proxy (default `127.0.0.1:9050`) + the probe timeout in seconds (default 30, Tor is slow).

## Deploy (on rave-01)

The script's deployed path is `/opt/fluncle-rave-watchdog/fluncle-rave-watchdog.sh` (sibling to the other box binaries, e.g. `/opt/fluncle-dns/fluncle-dns`); the unit `ExecStart` references it there.

```bash
# 1. Drop the script (0755) at its deployed path.
sudo install -D -m 0755 apps/ssh/watchdog/fluncle-rave-watchdog.sh \
  /opt/fluncle-rave-watchdog/fluncle-rave-watchdog.sh

# 2. Place the 0600 operator env file (values from the ops runbook note in 1Password).
#    Keys: RAVE01_BEACON_URL, WATCH_STATUS_URL, WATCH_STALE_MINUTES, DISCORD_ALERT_WEBHOOK,
#    + (job 3 / onion) WATCH_ONION_URL, WATCH_WORKER_URL, FLUNCLE_API_TOKEN.
sudo install -d -m 0755 /etc/fluncle
sudo install -m 0600 /dev/null /etc/fluncle/rave-watchdog.env
sudo "$EDITOR" /etc/fluncle/rave-watchdog.env   # paste the four keys

# 3. Install the units, reload, enable + start the timer.
sudo install -m 0644 apps/ssh/watchdog/fluncle-rave-watchdog.service /etc/systemd/system/
sudo install -m 0644 apps/ssh/watchdog/fluncle-rave-watchdog.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-rave-watchdog.timer

# Verify: a one-off run + the timer schedule.
sudo systemctl start fluncle-rave-watchdog.service   # run once now
journalctl -u fluncle-rave-watchdog.service -n 30 --no-pager
systemctl list-timers fluncle-rave-watchdog.timer
```

The `.service` is `Type=oneshot` (the timer drives the cadence) and hardened to mirror `apps/dns/fluncle-dns.service`: `DynamicUser=yes` (no real account to manage), a persistent `StateDirectory=fluncle-rave-watchdog` (survives across runs and works with `DynamicUser`), `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, an empty `CapabilityBoundingSet`, and a `@system-service` syscall filter. The only thing it needs at runtime is `curl` and outbound network.

## External beacon setup (provider-agnostic)

The two beacon URLs (`RAVE01_BEACON_URL` here, `HEALTHCHECK_BEACON_URL` on rave-02) point at an external uptime/dead-man's-switch service. Any healthchecks.io-style provider works (healthchecks.io, BetterUptime, Cronitor, a self-hosted instance) — the contract is just "an HTTP URL you ping on a schedule; if the pings stop past a grace period, the service alerts."

One-time operator setup:

1. Create **two checks** on the service — one for rave-01, one for rave-02 — each with the expected ping period set to that box's tick interval (~10m), and a **grace period a bit over** that interval (so a single missed ping from jitter or a slow tick doesn't false-alarm — e.g. ~15–20m).
2. Wire the service's alert channel to **Discord** (most providers have a native Discord/webhook integration), so a stopped beacon lands in the same place as the on-box transition alerts.
3. Put each check's ping URL into the matching box's env file: rave-01's URL → `RAVE01_BEACON_URL` in `/etc/fluncle/rave-watchdog.env` (this box); rave-02's URL → `HEALTHCHECK_BEACON_URL` in rave-02's `${HOME}/.healthcheck.env` (the Hermes box — see [`docs/agents/hermes/cron/README.md` § The healthcheck cron](../../../docs/agents/hermes/cron/README.md)).

Both beacon vars are **optional**: leave them unset and that box simply doesn't ping (the on-box cross-ping still runs). Record the real check URLs in the ops runbook note in 1Password — never in the repo.
