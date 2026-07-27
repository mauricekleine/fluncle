# fluncle-healthcheck-timer — the prober on a host timer

The rave-02 (Hermes box) host half of the `/status` health loop. `fluncle-healthcheck` is the prober behind Fluncle's public [`/status`](https://www.fluncle.com/status) dashboard: every ~10m it probes each service (web / R2 / DNS / the SSH app / the on-box automation crons / the scale-to-zero render box / Hermes itself), detects status transitions, Discord-pings on a flip (and again when a service stays down — see [Alerting](#alerting-the-flip-and-the-streak)), and POSTs the snapshot to the agent-tier `record_health` op the page reads. This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked probe script inside the `hermes` container every 10m.

The probe WORK is unchanged and BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/fluncle-healthcheck.sh`](../scripts/fluncle-healthcheck.sh) → [`../scripts/fluncle-healthcheck.ts`](../scripts/fluncle-healthcheck.ts)); it rides the image and auto-updates from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; there is no host-side wrapper script.

## Why it's a host timer, not a Hermes cron

A prober must not depend on the thing it monitors. As a Hermes `--no-agent` gateway cron, `fluncle-healthcheck` shared the one cron runner with the busy automation sweeps (enrich, context-note, note, observation, render, …). When a long sweep ran or several jobs piled up on an hour boundary, the gateway delayed the prober's 10m tick well past the rave-01 watchdog's 30m staleness threshold — so the board flapped "rave-02 prober dark" even though the box was perfectly healthy. The prober was being starved by the exact scheduler whose health it reports.

Moving it to a **host** systemd timer decouples it: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time. This is the same reasoning that makes the [`fluncle-pin-watch`](../pin-watch/README.md) self-deploy a host timer (a container can't cleanly rebuild itself) and the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog) a host-level watchdog (a watcher must outlive what it watches). The Hermes-container crons do _app_ work that can queue; this does _monitoring_ work that must not.

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/fluncle-healthcheck.sh` (the host unit runs as root to drive the Docker daemon; `-u hermes` runs the probe work unprivileged, matching every other `fluncle-*` sweep timer):

1. The container's `fluncle-healthcheck.sh` sources the `0600` `${HOME}/.healthcheck.env` (the probe targets + the Discord webhook) and execs the bun orchestrator.
2. `fluncle-healthcheck.ts` probes each service in parallel (each with a short 3–5s timeout), diffs every status against `${HOME}/.healthcheck/state.json`, Discord-pings on a flip to `down`, a recovery, or a down streak crossing an escalation rung, and POSTs the snapshot to the agent-tier `record_health` op that `/status` reads.
3. It pings the optional external dead-man's-switch beacon (`HEALTHCHECK_BEACON_URL`) so an outside service alerts if THIS box ever stops ticking, and prints one JSON summary line.

A clean tick runs ~5s, well inside the unit's `TimeoutStartSec=300` (raised from 120s so a pin-watch docker image build's ~4-min CPU-contention window can't false-kill the prober and masquerade a build as an outage). The prober's own `cron.healthcheck` `/status` row is now **self-evident** (reaching the probe means the timer fired → `ok`), not a gateway-output-dir read — a host-timer prober has no Hermes cron output dir of its own, and reading its own would be circular.

## Alerting: the flip and the streak

Two rules, because one was not enough. **The flip** is edge-triggered: a service going `down`, or recovering out of it, posts one line naming what changed. That rule alone is structurally silent about DURATION — a 2026-07-27 audit found a sweep that failed every hour for ~20 hours, where the prober was correct on every tick and said so exactly once, at the start.

So the state file also carries a per-service **consecutive-down streak**, and a service still down after `HEALTHCHECK_ESCALATE_AFTER` ticks (default 6 ≈ 1h at the 10m cadence) posts a louder line carrying the streak and its wall-clock length: `🚨 cron.render STILL DOWN — 6 consecutive checks (~1h). This is not a transient.` Escalations then repeat on a doubling ladder — 6, 12, 24, 48 … — so a day-long outage stays visible as a handful of lines rather than 144 identical ones. Any recovery (`ok` or `degraded`) resets both the streak and the ladder, so a flapping service never accumulates its way to an escalation.

The state file is versioned and read defensively: an older or truncated file degrades to fresh counters rather than throwing, because a prober that crashes on its own state takes the dead-man's beacon down with it. And that beacon is the boundary of this mechanism — escalation only covers surfaces the prober probes **while it is alive**; the prober's own death is what `HEALTHCHECK_BEACON_URL` is for.

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
