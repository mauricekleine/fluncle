# fluncle-capture-timer — the full-song capture sweep on a host timer

The rave-02 (Hermes box) host trigger for the full-song **capture** sweep. `fluncle-capture` captures each finding's full song once — `yt-dlp` a YouTube match through a residential proxy on a per-track sticky session, duration-guard it against the finding's Spotify length, and store the bytes in the PRIVATE `fluncle-source-audio` R2 bucket — then writes the key + status back via the agent-tier `update_track` op. It is a NON-BLOCKING side-channel that never gates the enrich/embed queues (docs/full-audio-rfc.md § Unit 1). This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the already-deployed sweep script inside the `hermes` container every 5m.

The sweep WORK lives in the container — the `.sh`/`.ts` pair at `/opt/data/scripts/` (source: [`../scripts/capture-sweep.sh`](../scripts/capture-sweep.sh) → [`../scripts/capture-sweep.ts`](../scripts/capture-sweep.ts)). The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/data/scripts/capture-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` and execs bun).

## Why it's a host timer, not a Hermes cron

Capture's per-finding work has an **unbounded tail**: it spawns `yt-dlp` against a residential proxy (a 60s search + up to a 180s download) for up to `BATCH_CAP` findings a tick. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` — a worst-case tick during the whole-archive backfill drain would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. A prober that starves the enrich sweep is exactly the failure the [`fluncle-healthcheck`](../healthcheck-timer/README.md) move fixed; capture has the same shape (long, tail-latent work that must not queue behind — or ahead of — the fast app sweeps), so it runs on a **host** systemd timer for the same reason: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow download can never delay another cron. (Same reasoning as [`fluncle-pin-watch`](../pin-watch/README.md) — a container can't cleanly rebuild itself — and the rave-01 watchdog.)

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/capture-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. The container's `capture-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the AGENT `FLUNCLE_API_TOKEN`, the residential-proxy creds, the `fluncle-source-audio` R2 creds, `R2_ACCOUNT_ID`) and execs the bun orchestrator.
2. `capture-sweep.ts` reads the capture queue over direct HTTP (`GET /api/admin/tracks?captureQueue=true&order=desc` — newest-first, backoff-aware), takes up to `BATCH_CAP` (4), and per finding: searches `yt-dlp` on a per-track sticky proxy session, picks the candidate within the duration guard, downloads `-f bestaudio`, ffprobe-confirms the length, PUTs the bytes S3-direct to `fluncle-source-audio` at `<logId>/<sha256>.<ext>`, and PATCHes `update_track` with the key + `capture_status='done'` (or `unmatched`/`failed`). It prints one JSON summary line.
3. `cron.capture`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … capture-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-capture` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

`yt-dlp` lives at `/opt/data/scripts/yt-dlp` (on the sweep's PATH, alongside the script on the persistent volume) and `ffprobe` (ffmpeg) is in the image — box deploy prereqs; keep `yt-dlp` fresh (YouTube's bot-walls move). The persistent-volume binary survives restarts + image rebuilds but does NOT auto-update; the durable hardening is baking it into the hermes image with a freshen (a `fluncle-hermes-operator` follow-up).

## Deploy (on rave-02, one time)

```bash
# 1. Deploy the sweep pair into the container (~/.hermes is hermes-owned 700 — copy IN via
#    docker cp, like the other box scripts).
docker cp docs/agents/hermes/scripts/capture-sweep.sh hermes:/opt/data/scripts/
docker cp docs/agents/hermes/scripts/capture-sweep.ts hermes:/opt/data/scripts/
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/capture-sweep.* && chmod +x /opt/data/scripts/capture-sweep.sh'

# 2. Install yt-dlp onto the persistent volume (on the sweep's PATH; ffmpeg is already in
#    the image). Survives restarts + image rebuilds; re-run to freshen when YouTube moves.
curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp
docker cp /tmp/yt-dlp hermes:/opt/data/scripts/yt-dlp
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/yt-dlp && chmod +x /opt/data/scripts/yt-dlp' && rm -f /tmp/yt-dlp

# 3. Install the host units.
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/capture-timer/fluncle-capture.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-capture.timer

# Verify.
sudo systemctl start fluncle-capture.service            # one tick now
journalctl -u fluncle-capture.service -n 40 --no-pager  # expect a { "ok": true, "done": … } summary line
systemctl list-timers fluncle-capture.timer
```

Smoke-test the sweep as the cron user first (it sources the same secrets file): `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/capture-sweep.sh` → expect an `{ "ok": true, "done": … }` summary and an object keyed by the finding's Log ID in the private `fluncle-source-audio` bucket. The tick is idempotent + backoff-aware, so the timer is safe to run as often as the cadence; if it ever stops, `cron.capture` simply goes stale on `/status`.
