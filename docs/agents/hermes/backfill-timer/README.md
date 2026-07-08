# fluncle-backfill-timer — the catalogue-backfill sweep on a host timer

The rave-02 host trigger for the `--no-agent` **backfill** sweep. `fluncle-backfill` repairs the two music-graph side-channels over already-published findings — the Discogs release-id resolve and the Last.fm love. The box holds no vendor keys, so it just PACES the Worker (one bounded batch of each source per tick, `--limit 6`); the Worker carries the per-finding reliability state + the Retry-After backoff. Zero box tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 30m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backfill-sweep.sh`](../scripts/backfill-sweep.sh) → [`../scripts/backfill-sweep.ts`](../scripts/backfill-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backfill`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backfill` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/backfill-timer/fluncle-backfill.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/backfill-timer/fluncle-backfill.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-backfill.timer

# Verify.
sudo systemctl start fluncle-backfill.service            # one tick now
journalctl -u fluncle-backfill.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-backfill.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-backfill`) so it is not double-scheduled — green the timer first, never both live at once.
