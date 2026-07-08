# fluncle-artist-follow-timer — the artist auto-follow sweep on a host timer

The rave-02 host trigger for the `--no-agent` **artist auto-follow** sweep. `fluncle-artist-follow` is the championing motion's automated half: it paces the follow endpoint (one bounded batch per tick via the `fluncle` CLI), and the Worker performs the YouTube `subscriptions.insert` then stamps `followed_at`. YouTube-only (Spotify auto-follow is dev-mode-gated; manual championing via `/admin/artists`). Idempotent by construction (`followed_at IS NULL`, acting only on `status IN (auto, confirmed)`). Zero box tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 6h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/artist-follow-sweep.sh`](../scripts/artist-follow-sweep.sh) → [`../scripts/artist-follow-sweep.ts`](../scripts/artist-follow-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-artist-follow`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.artist-follow` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/artist-follow-timer/fluncle-artist-follow.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/artist-follow-timer/fluncle-artist-follow.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-artist-follow.timer

# Verify.
sudo systemctl start fluncle-artist-follow.service            # one tick now
journalctl -u fluncle-artist-follow.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-artist-follow.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-artist-follow`) so it is not double-scheduled — green the timer first, never both live at once.
