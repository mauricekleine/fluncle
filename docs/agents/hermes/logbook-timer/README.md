# fluncle-logbook-timer — the nightly Logbook authoring sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **Logbook** sweep. `fluncle-logbook` authors the previous day's entry in [Fluncle's Logbook](../../logbook-agent.md) — a first-person travelogue, one entry per sector-day. Deterministic everywhere (the gap read + the day's material gather via the agent-tier `list_logbook_gaps` op, and the write-back via the agent-tier `create_logbook_entry` op) except one `claude -p` authoring call per day, and fill-empty-only (an operator entry, or a previously-authored one, is never clobbered). A host systemd timer `docker exec`s the baked sweep inside the `hermes` container once a day at 00:40 Amsterdam.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/logbook-sweep.sh`](../scripts/logbook-sweep.sh) → [`../scripts/logbook-sweep.ts`](../scripts/logbook-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator.

## Why 00:40 Amsterdam (once a day)

An entry is authored only once a sector-day is COMPLETE — the gap window excludes the in-progress day (`sector < todaySector`) — so the timer fires shortly after local midnight to write up the day that just ended. One day per tick (`BATCH_CAP=1`); the self-healing gap window backfills history OLDEST-FIRST over successive nights (see the backfill note below).

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-logbook`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.logbook` row stays honest.

## Deploy (on rave-02, one time) — OPERATOR-GATED

This is a NEW cron; nothing is retired. Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh) (it auto-discovers every `*-timer/` dir, so this one is picked up), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/logbook-timer/fluncle-logbook.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/logbook-timer/fluncle-logbook.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-logbook.timer

# Verify.
sudo systemctl start fluncle-logbook.service            # one tick now
journalctl -u fluncle-logbook.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-logbook.timer
```

### The `claude -p` token

The `--no-agent` runner withholds provider credentials, so `claude -p`'s subscription token reaches the sweep only via a 0600 operator-placed file (the same file `fluncle-note` uses): `${HOME}/.fluncle-secrets.env` (mounted `~/.hermes`) holding `CLAUDE_CODE_OAUTH_TOKEN` (required) plus optionally `DISCORD_ALERT_WEBHOOK`, `LOGBOOK_CLAUDE_MODEL` (default `claude-sonnet-4-6`), and `LOGBOOK_CLAUDE_EFFORT`. Written from the configured 1Password item (see the ops runbook note). If it is missing, the sweep leaves the gap list untouched and pings Discord on an auth signature.

## Backfill — the first runs

On a fresh activation there is a BACKLOG: every past sector-day with findings but no entry. The self-healing window drains it OLDEST-FIRST, one day per nightly tick, so history fills in over successive nights with no manual step. To drain faster, the operator can run extra manual ticks (`sudo systemctl start fluncle-logbook.service`, once per day authored) or temporarily raise `BATCH_CAP` in `logbook-sweep.ts` (re-bake) — but a slow, one-a-night backfill is the intended, quota-cheap default. The gap list IS the durable worklist; nothing is lost between ticks.
