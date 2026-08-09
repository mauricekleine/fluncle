# fluncle-backfill-timer — the catalogue-backfill sweep on a host timer

The Hermes box trigger for the `--no-agent` **backfill** sweep. `fluncle-backfill` repairs the music-graph side-channels over already-published findings — the Discogs release-id resolve, the Last.fm love, and the Apple Music URL — and drains their catalogue siblings. The two Discogs legs use the same split as label images: the Worker prepares bounded work, the box performs only paced vendor reads, and the Worker re-verifies the candidates and owns every write. The other vendor legs retain their Worker/CLI paths. Zero box tokens. A host systemd timer runs the baked sweep every 30 minutes.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backfill-sweep.sh`](../scripts/backfill-sweep.sh) → [`../scripts/backfill-sweep.ts`](../scripts/backfill-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backfill`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backfill` row stays honest. The prober is UNCHANGED.

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
