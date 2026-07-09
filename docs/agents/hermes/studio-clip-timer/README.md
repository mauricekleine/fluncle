# fluncle-studio-clip-timer — the Fluncle Studio clip-cut sweep on a host timer

The rave-02 host trigger for the `--no-agent` **Fluncle Studio clip-cut** sweep. `fluncle-studio-clip` (#215) cuts a published mixtape set into the framed **9:16 clips** the Studio library hands off — a deterministic ffmpeg job (trim + 9:16 crop + brand frame) → PUT `<clipId>/footage.mp4` to R2 → finalize, cap 1 clip/tick, zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 15m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/clip-sweep.sh`](../scripts/clip-sweep.sh) → [`../scripts/clip-sweep.ts`](../scripts/clip-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## This is the LIVE clip cron (not clip-drip)

There are two clip crons in the tree. This one — `fluncle-studio-clip` (`clip-sweep.sh`, the Studio set→clip cut) — is the LIVE one and migrates here. The separate `clip-drip-sweep.sh` (the clip→Instagram drip-feed) is DELIBERATELY un-deployed (excluded from the Unit A bake), so it gets **no** host timer until its own go-live. Note the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober currently tracks a `cron.clip-drip` row (match `clip-drip`), NOT `cron.studio-clip` — so this sweep's marker (`# Cron Job: fluncle-studio-clip`) is written for future prober support but is not yet read on `/status` (studio-clip was never in `AUTOMATION_CRONS`; that follow-up is noted in `../cron/README.md`).

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the marker via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/studio-clip-timer/fluncle-studio-clip.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/studio-clip-timer/fluncle-studio-clip.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-studio-clip.timer

# Verify.
sudo systemctl start fluncle-studio-clip.service            # one tick now
journalctl -u fluncle-studio-clip.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-studio-clip.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-studio-clip`) so it is not double-scheduled — green the timer first, never both live at once.
