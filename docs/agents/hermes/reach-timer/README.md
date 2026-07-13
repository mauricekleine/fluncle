# fluncle-reach-timer — the daily /reach snapshot on a host timer

The rave-02 host trigger for the `--no-agent` **reach** sweep. `fluncle-reach` fires one `fluncle admin reach collect` a day: the WORKER fetches every Tier-1 platform (Mixcloud, Bluesky, GitHub, npm, Last.fm, YouTube, Telegram, the newsletter, the Spotify playlist, …), each best-effort, and upserts one idempotent snapshot row per (platform, metric) keyed by `${platform}:${metric}:${yyyy-mm-dd}` — the append-only series behind the public /reach page (how far Fluncle's tentacles stretch across the web). Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/reach-sweep.sh`](../scripts/reach-sweep.sh) → [`../scripts/reach-sweep.ts`](../scripts/reach-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). It calls the baked `fluncle` CLI's `admin reach collect`; the box's agent-scoped token (which rides the container env like the other CLI sweeps) drives the AGENT-tier `record_platform_stats` op. **No new secret** — every platform credential lives Worker-side, which is the whole reason the box cron is a bare trigger.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-reach`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.reach` row stays honest. The prober is UNCHANGED.

## Activation (on rave-02, one time — operator-gated)

This is a NEW cron; nothing to retire. It goes live with a single `install-host-timers.sh` run on the box (which discovers every `*-timer/` dir), or install just this one:

```bash
sudo install -m 0644 docs/agents/hermes/reach-timer/fluncle-reach.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/reach-timer/fluncle-reach.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-reach.timer

# Verify (a manual tick takes a real snapshot — safe + idempotent within the day's slot).
sudo systemctl start fluncle-reach.service            # one tick now
journalctl -u fluncle-reach.service -n 40 --no-pager  # expect a { "ok": true, "inserted": N, … } summary line
systemctl list-timers fluncle-reach.timer
```

The baked CLI must carry `admin reach collect`. It ships via the automatic release → pin-bump → rebake chain (the reach spine's CLI release already triggered it); once pin-watch has rebaked the image past that release, the sweep resolves the verb. Before then a tick exits nonzero (`did not return JSON` / unknown command) and reads as a failing row on /status — expected until the rebake lands.
