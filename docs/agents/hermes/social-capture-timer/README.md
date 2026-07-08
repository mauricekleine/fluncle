# fluncle-social-capture-timer — the social-URL-capture sweep on a host timer

The rave-02 host trigger for the `--no-agent` **social-URL-capture** sweep. `fluncle-social-capture` captures the public post URLs Postiz withholds on create (the YouTube watch URL, the TikTok permalink) and writes them back, flipping a captured TikTok inbox draft `draft` → `published`. The box holds no Postiz key, so it just TRIGGERS — one `curl` POST to the agent-tier `/api/admin/social/posts/capture` per tick, and the Worker does the work. Zero box tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 10m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — a lone [`../scripts/social-capture-sweep.sh`](../scripts/social-capture-sweep.sh) (no `.ts`; the whole job is one POST) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-social-capture`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper — it wraps the `curl` so the marker lands even when the trigger fails — so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.social-capture` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/social-capture-timer/fluncle-social-capture.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/social-capture-timer/fluncle-social-capture.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-social-capture.timer

# Verify.
sudo systemctl start fluncle-social-capture.service            # one tick now
journalctl -u fluncle-social-capture.service -n 40 --no-pager  # expect a 2xx (no output on an empty backlog)
systemctl list-timers fluncle-social-capture.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-social-capture`) so it is not double-scheduled — green the timer first, never both live at once.
