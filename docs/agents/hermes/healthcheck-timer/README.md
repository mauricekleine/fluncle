# fluncle-healthcheck-timer — the prober on a host timer

The rave-02 (Hermes box) host half of the `/status` health loop. `fluncle-healthcheck` is the prober behind Fluncle's public [`/status`](https://www.fluncle.com/status) dashboard: every ~10m it probes each service (web / R2 / DNS / the SSH app / the on-box automation crons / the scale-to-zero render box / Hermes itself), detects status transitions, Discord-pings only on a flip, and POSTs the snapshot to the agent-tier `record_health` op the page reads. This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked probe script inside the `hermes` container every 10m.

The probe WORK is unchanged and BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/fluncle-healthcheck.sh`](../scripts/fluncle-healthcheck.sh) → [`../scripts/fluncle-healthcheck.ts`](../scripts/fluncle-healthcheck.ts)); it rides the image and auto-updates from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; there is no host-side wrapper script.

## Why it's a host timer, not a Hermes cron

A prober must not depend on the thing it monitors. As a Hermes `--no-agent` gateway cron, `fluncle-healthcheck` shared the one cron runner with the busy automation sweeps (enrich, context-note, note, observation, render, …). When a long sweep ran or several jobs piled up on an hour boundary, the gateway delayed the prober's 10m tick well past the rave-01 watchdog's 30m staleness threshold — so the board flapped "rave-02 prober dark" even though the box was perfectly healthy. The prober was being starved by the exact scheduler whose health it reports.

Moving it to a **host** systemd timer decouples it: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time. This is the same reasoning that makes the [`fluncle-pin-watch`](../pin-watch/README.md) self-deploy a host timer (a container can't cleanly rebuild itself) and the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog) a host-level watchdog (a watcher must outlive what it watches). The Hermes-container crons do _app_ work that can queue; this does _monitoring_ work that must not.

## What a run does

Each tick is one `docker exec -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/fluncle-healthcheck.sh`:

1. The container's `fluncle-healthcheck.sh` sources the `0600` `${HOME}/.healthcheck.env` (the probe targets + the Discord webhook) and execs the bun orchestrator.
2. `fluncle-healthcheck.ts` probes each service in parallel (each with a short 3–5s timeout), diffs every status against `${HOME}/.healthcheck/state.json`, Discord-pings only on a flip to `down` or a recovery, and POSTs the snapshot to the agent-tier `record_health` op that `/status` reads.
3. It pings the optional external dead-man's-switch beacon (`HEALTHCHECK_BEACON_URL`) so an outside service alerts if THIS box ever stops ticking, and prints one JSON summary line.

A clean tick runs ~5s, well inside the unit's `TimeoutStartSec=120` (which matches the old `--no-agent` cron's 120s job budget). The prober's own `cron.healthcheck` `/status` row is now **self-evident** (reaching the probe means the timer fired → `ok`), not a gateway-output-dir read — a host-timer prober has no Hermes cron output dir of its own, and reading its own would be circular.

## Deploy (on rave-02, one time)

The probe script is BAKED into the image at `/opt/hermes-scripts/` (it rides the image and auto-updates from `main` via pin-watch — no `docker cp`), so **no script redeploy is needed**. This is only the host-timer install plus retiring the old gateway cron.

```bash
# 1. Install the host units.
sudo install -m 0644 docs/agents/hermes/healthcheck-timer/fluncle-healthcheck.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/healthcheck-timer/fluncle-healthcheck.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-healthcheck.timer

# 2. Retire the old Hermes gateway cron (the host timer now owns the schedule).
docker exec hermes hermes cron remove fluncle-healthcheck

# Verify.
sudo systemctl start fluncle-healthcheck.service        # one tick now
journalctl -u fluncle-healthcheck.service -n 40 --no-pager
systemctl list-timers fluncle-healthcheck.timer
```

The tick is idempotent and cheap, so the timer is safe to run as often as you like. If the timer ever stops, the `/status` rows simply go stale and the external beacon stops pinging — which is itself the signal that the prober is down.
