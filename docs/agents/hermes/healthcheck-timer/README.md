# fluncle-healthcheck-timer — the prober on a host timer

The rave-02 (Hermes box) host half of the `/status` health loop. `fluncle-healthcheck` is the prober behind Fluncle's public [`/status`](https://www.fluncle.com/status) dashboard: every ~10m it probes each service (web / R2 / DNS / the SSH app / the on-box automation crons / the scale-to-zero render box / Hermes itself), detects status transitions, Discord-pings on a flip (and again when a service stays down — see [Alerting](#alerting-the-flip-and-the-streak)), and POSTs the snapshot to the agent-tier `record_health` op the page reads. This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked probe script inside the `hermes` container every 10m.

The probe WORK is unchanged and BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/fluncle-healthcheck.sh`](../scripts/fluncle-healthcheck.sh) → [`../scripts/fluncle-healthcheck.ts`](../scripts/fluncle-healthcheck.ts)); it rides the image and auto-updates from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; there is no host-side wrapper script.

## Why it's a host timer, not a Hermes cron

A prober must not depend on the thing it monitors. As a Hermes `--no-agent` gateway cron, `fluncle-healthcheck` shared the one cron runner with the busy automation sweeps (enrich, context-note, note, observation, render, …). When a long sweep ran or several jobs piled up on an hour boundary, the gateway delayed the prober's 10m tick well past the rave-01 watchdog's 30m staleness threshold — so the board flapped "rave-02 prober dark" even though the box was perfectly healthy. The prober was being starved by the exact scheduler whose health it reports.

Moving it to a **host** systemd timer decouples it: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time. This is the same reasoning that makes the [`fluncle-pin-watch`](../pin-watch/README.md) self-deploy a host timer (a container can't cleanly rebuild itself) and the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog) a host-level watchdog (a watcher must outlive what it watches). The Hermes-container crons do _app_ work that can queue; this does _monitoring_ work that must not.

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/fluncle-healthcheck.sh` (the host unit runs as root to drive the Docker daemon; `-u hermes` runs the probe work unprivileged, matching every other `fluncle-*` sweep timer):

1. The container's `fluncle-healthcheck.sh` sources the `0600` `${HOME}/.healthcheck.env` (the probe targets + the Discord webhook) and execs the bun orchestrator.
2. `fluncle-healthcheck.ts` probes each service in parallel (each with a short 3–5s timeout), diffs every status against `${HOME}/.healthcheck/state.json`, Discord-pings on a flip to `down`, a recovery, or a down streak crossing an escalation rung, and POSTs the snapshot to the agent-tier `record_health` op that `/status` reads. The write carries the stable `hermes-healthcheck` producer ID, a producer-scoped key derived from the canonical UTC timestamp, and the canonical request digest. After an ambiguous POST failure, the caller sends digest-bound read-only reconciliation before any replay: committed is success and only confirmed absence under flag-on permits another POST; flag-off, conflict, rejected, in-progress, not-found, or lookup failure stops without replay.
3. It pings the optional external dead-man's-switch beacon (`HEALTHCHECK_BEACON_URL`) so an outside service alerts if THIS box ever stops ticking, and prints one JSON summary line.

A clean tick runs ~5s, well inside the unit's `TimeoutStartSec=430`; that ceiling preserves its 300-second payload budget after the admission runner's bounded wait. The prober's own `cron.healthcheck` `/status` row is now **self-evident** (reaching the probe means the timer fired → `ok`), not a gateway-output-dir read — a host-timer prober has no Hermes cron output dir of its own, and reading its own would be circular.

## Alerting: the flip and the streak

Two rules, because one was not enough. **The flip** is edge-triggered: a service going `down`, or recovering out of it, posts one line naming what changed. That rule alone is structurally silent about DURATION — a 2026-07-27 audit found a sweep that failed every hour for ~20 hours, where the prober was correct on every tick and said so exactly once, at the start.

So the state file also carries a per-service **consecutive-down streak**, and a service still down after `HEALTHCHECK_ESCALATE_AFTER` ticks (default 6 ≈ 1h at the 10m cadence) posts a louder line carrying the streak and its wall-clock length: `🚨 cron.render STILL DOWN — 6 consecutive checks (~1h). This is not a transient.` Escalations then repeat on a doubling ladder — 6, 12, 24, 48 … — so a day-long outage stays visible as a handful of lines rather than 144 identical ones. Any recovery (`ok` or `degraded`) resets both the streak and the ladder, so a flapping service never accumulates its way to an escalation.

The state file is versioned and read defensively: an older or truncated file degrades to fresh counters rather than throwing, because a prober that crashes on its own state takes the dead-man's beacon down with it. And that beacon is the boundary of this mechanism — escalation only covers surfaces the prober probes **while it is alive**; the prober's own death is what `HEALTHCHECK_BEACON_URL` is for.

## Sweep strain: the errors a green tick can hide

Both rules above are built on a cron's `{ ok }` verdict, and that verdict is the sweep's opinion of its TICK, not of its WORK. A sweep that walks a batch of ten, loses a few individual items, and returns `{"ok":true,"failed":3}` is telling the truth — the tick ran, the queue is intact, it retries on its own cadence — and the run ledger deliberately treats that as healthy. A genuinely stuck batch still matters, as does the same entity failing its voice gate on every pass, but the detector must distinguish those conditions from ordinary partial work.

Nothing COULD read the rest, in fact: every sweep's `log()` is `console.error`, and `cron-output.sh` used to capture stdout only, so the marker on disk held the JSON summary and not one word of the errors. Both halves are fixed together — the wrapper now appends a bounded, delimited, blockquoted tail of the sweep's stderr below the summary (see [`../scripts/cron-output.sh`](../scripts/cron-output.sh)), and the prober reads it.

The rule, in plain words: **count run-level `errors`, stuck-loop `gateSkipped`, and nullable `error` directly; count item-level `failed` only when it reaches 50% of a real `checked` denominator; then report a sweep once its points reach 25% of the scheduled ticks in `max(6 hours, 3 × cadence)` AND are spread across at least three separate ticks.** A high-rate item tick earns one point regardless of batch size. At the fleet's fastest cadence that means 90 of 360 scheduled ticks in six hours must each lose at least half their checked work; at the slowest cadence all three scheduled ticks in 21 days must do so. A missing or zero `checked` means the item rate cannot be judged and contributes nothing.

Evidence remains explicit and bounded. `STRAIN_PHRASES` is the fallback for legacy summaries that carry no structured `failed` field, but the bare substrings `failed` and `failure` are deliberately absent because prose occurrences have no `checked` denominator. Once a structured `failed` is present, the summary owns item-failure judgment and matching stderr lines cannot bypass the denominator or double-count the tick. The direct summary vocabulary is `errors`, `gateSkipped`, and nullable `error`; the rate pair is `failed / checked`. Counter values may be numbers or arrays. `skipped` and `unmatched` remain ordinary outcomes, and there is no `/error/i` catch-all: a detector that fires on the 471-a-day `embedded + written` line is worse than no detector.

Designed backpressure is a separate, non-alarming axis. A summary carrying `throttled: true` means the sweep stopped cleanly at a vendor limit and will resume next tick; the healthy `sweep-errors` row names those sweeps as having yielded cleanly, but the event contributes no failure points and never degrades the row.

Three properties worth knowing before touching it:

- **It never edits a sweep's own verdict.** `cron.capture` still reports exactly what capture said about itself. Strain is a SEPARATE signal on its own `sweep-errors` row — one aggregate row rather than ~35, because `service_status` rows are upserted and never deleted, so a row minted for a one-afternoon condition would sit on the public board forever.
- **The row is `degraded`, never `down`.** Every strained sweep is running. The loud channel is Discord, which is edge-triggered on entering and leaving the condition and names the sweeps the aggregate row cannot.
- **Every threshold is env-overridable**, in one block in `fluncle-healthcheck.ts` (`HEALTHCHECK_STRAIN_ITEM_FAILURE_RATE` = 0.5, `HEALTHCHECK_STRAIN_WINDOW_MS` = 6h floor, `HEALTHCHECK_STRAIN_FAILURE_RATE` = 0.25, `HEALTHCHECK_STRAIN_TICKS` = 3). The per-cron window can never be shorter than three of that cron's cadences. Tuning after measured box data needs an env change and a timer restart, not a rebake.

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
