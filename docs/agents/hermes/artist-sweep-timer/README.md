# fluncle-artist-sweep-timer — the artist-resolution sweep on a host timer

The rave-02 host trigger for the `--no-agent` **artist-resolution** sweep. `fluncle-artist-sweep` paces the agent-tier `resolve_artist` endpoint — the box holds no Firecrawl key and no YouTube OAuth, so it just TRIGGERS one bounded batch per tick, and the Worker runs the MusicBrainz url-rel walk, the Firecrawl `/v2/extract` gap-fill, and the YouTube channel-ID resolution. Zero box tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 60m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/artist-sweep.sh`](../scripts/artist-sweep.sh) → [`../scripts/artist-sweep.ts`](../scripts/artist-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-artist-sweep`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.artist-sweep` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/artist-sweep-timer/fluncle-artist-sweep.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/artist-sweep-timer/fluncle-artist-sweep.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-artist-sweep.timer

# Verify.
sudo systemctl start fluncle-artist-sweep.service            # one tick now
journalctl -u fluncle-artist-sweep.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-artist-sweep.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-artist-sweep`) so it is not double-scheduled — green the timer first, never both live at once.
