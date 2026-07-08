# fluncle-capture-timer — the full-song capture sweep on a host timer

The rave-02 (Hermes box) host trigger for the full-song **capture** sweep. `fluncle-capture` captures each finding's full song once — `yt-dlp` a YouTube match through a residential proxy on a per-track sticky session, duration-guard it against the finding's Spotify length, and store the bytes in the PRIVATE `fluncle-source-audio` R2 bucket — then writes the key + status back via the agent-tier `update_track` op. It is a NON-BLOCKING side-channel that never gates the enrich/embed queues (docs/rfcs/full-audio-rfc.md § Unit 1). This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked sweep script inside the `hermes` container every 5m.

The sweep WORK is BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/capture-sweep.sh`](../scripts/capture-sweep.sh) → [`../scripts/capture-sweep.ts`](../scripts/capture-sweep.ts)) plus the PINNED `yt-dlp` fetcher at `/opt/hermes-scripts/yt-dlp`. Both ride the image and auto-update from `main` via the hourly pin-watch rebuild (Unit A/D) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/hermes-scripts/capture-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` and execs bun).

## Why it's a host timer, not a Hermes cron

Capture's per-finding work has an **unbounded tail**: it spawns `yt-dlp` against a residential proxy (a 60s search + up to a 180s download) for up to `BATCH_CAP` findings a tick. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` — a worst-case tick during the whole-archive backfill drain would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. A prober that starves the enrich sweep is exactly the failure the [`fluncle-healthcheck`](../healthcheck-timer/README.md) move fixed; capture has the same shape (long, tail-latent work that must not queue behind — or ahead of — the fast app sweeps), so it runs on a **host** systemd timer for the same reason: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow download can never delay another cron. (Same reasoning as [`fluncle-pin-watch`](../pin-watch/README.md) — a container can't cleanly rebuild itself — and the rave-01 watchdog.)

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/capture-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. The container's `capture-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the AGENT `FLUNCLE_API_TOKEN`, the residential-proxy creds, the `fluncle-source-audio` R2 creds, `R2_ACCOUNT_ID`) and execs the bun orchestrator.
2. `capture-sweep.ts` reads the capture queue over direct HTTP (`GET /api/admin/tracks?captureQueue=true&order=desc` — newest-first, backoff-aware), takes up to `BATCH_CAP` (4), and per finding: searches `yt-dlp` on a per-track sticky proxy session, picks the best candidate via **channel-trust matching** (a candidate on the finding's label channel, a curated D&B aggregator, or the artist's own channel relaxes the duration guard asymmetrically — allowing the intro/outro padding a label video carries over the streaming master, bounded so an hour-long DJ set is still rejected; wrong-version titles de-rank), downloads `-f bestaudio`, ffprobe-confirms the length, PUTs the bytes S3-direct to `fluncle-source-audio` at `<logId>/<sha256>.<ext>`, and PATCHes `update_track` with the key + `capture_status='done'` (or `unmatched`/`failed`). It prints one JSON summary line.
3. `cron.capture`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … capture-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-capture` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

`yt-dlp` is **baked PINNED** (`2026.07.04`) at `/opt/hermes-scripts/yt-dlp` — an early Dockerfile layer above the frequently-bumped pins, on the sweep's PATH — and `ffprobe` (ffmpeg) is in the image. Both ride the image, so a rebuilt box has them already. Freshen `yt-dlp` when YouTube's bot-walls move by bumping the pin in the Dockerfile (a repo change that auto-deploys on the next pin-watch rebuild) — no hand-copied persistent-volume binary.

## Deploy (on rave-02, one time)

The image bake (Unit A/D) puts the sweep + the pinned `yt-dlp` in place under `/opt/hermes-scripts/`; you only install the host units. Do all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-capture.timer

# Verify.
sudo systemctl start fluncle-capture.service            # one tick now
journalctl -u fluncle-capture.service -n 40 --no-pager  # expect a { "ok": true, "done": … } summary line
systemctl list-timers fluncle-capture.timer
```

Smoke-test the sweep as the cron user first (it sources the same secrets file): `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/capture-sweep.sh` → expect an `{ "ok": true, "done": … }` summary and an object keyed by the finding's Log ID in the private `fluncle-source-audio` bucket. The tick is idempotent + backoff-aware, so the timer is safe to run as often as the cadence; if it ever stops, `cron.capture` simply goes stale on `/status`.
