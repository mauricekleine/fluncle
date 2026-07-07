# fluncle-embed-timer — the audio-embedding sweep on a host timer

The rave-02 (Hermes box) host trigger for the MuQ audio-**embedding** sweep. `fluncle-embed` embeds each finding's captured full song: S3-GET the `source_audio_key` bytes from the PRIVATE `fluncle-source-audio` R2 bucket, decode to 24 kHz mono, run MuQ over the song in ~30s windows, mean-pool to one 1024-d vector, and write it back via the agent-tier `update_track` op. The vector powers the live `/log` "more like this" row (`get_similar_findings` cosine). This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the already-deployed sweep script inside the `hermes` container every 5m.

The sweep WORK lives in the container — the `.sh`/`.ts`/`.py` trio at `/opt/data/scripts/` (source: [`../scripts/embed-sweep.sh`](../scripts/embed-sweep.sh) → [`../scripts/embed-sweep.ts`](../scripts/embed-sweep.ts) → [`../scripts/embed-track.py`](../scripts/embed-track.py)). The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/data/scripts/embed-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` for the R2 creds and execs bun). Unlike capture, embed needs NO `yt-dlp` — it only reads R2 and runs python (torch/MuQ + ffmpeg).

## Why it's a host timer, not a Hermes cron

Embed's per-finding work is **minutes-scale**: the source is now the CAPTURED FULL SONG (Unit 3), not the 30s preview, and a windowed MuQ forward over a ~5-min song is ~10 sequential window forwards. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` (and a 120s hard kill otherwise) — a full-song embed would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. So it runs on a **host** systemd timer, exactly like [`fluncle-capture`](../capture-timer/README.md) (whose proxied `yt-dlp` fetch has the same must-not-block-the-fast-sweeps shape), [`fluncle-healthcheck`](../healthcheck-timer/README.md), and [`fluncle-pin-watch`](../pin-watch/README.md): the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow embed can never delay another cron.

`BATCH_CAP=1` (one finding per tick) bounds the wall-clock, and `embed-track.py` **windows** the song so peak RAM is bounded by a single ~30s window's forward, never the whole song (a full-song single forward blows past the box's 8 GB — a 30s preview alone measured 2.85 GB). **Verify peak RAM < 8 GB on a real ~5-min captured track before enabling** (see below).

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/embed-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. The container's `embed-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the `fluncle-source-audio` R2 creds + `R2_ACCOUNT_ID`) and execs the bun orchestrator. The `fluncle` CLI's own admin auth (the queue read + the vector write-back) is the box's baked config under `HOME=/opt/data/home`, unchanged from the gateway-cron era.
2. `embed-sweep.ts` reads the embed queue (`fluncle admin tracks embed --queue --json`), which gates on `source_audio_key IS NOT NULL AND embedding_json IS NULL` (the key-gate + the DTO's `sourceAudioKey` field come from a separate slice — this orchestrator consumes them). It takes up to `BATCH_CAP` (1) and per finding: S3-GETs the `source_audio_key` bytes from `fluncle-source-audio` to a temp file, then hands a manifest to ONE `embed-track.py` call. `embed-track.py` decodes with ffmpeg, windows into non-overlapping ~30s chunks, MuQ-forwards each sequentially (freeing its tensors between windows), mean-pools each window over time → 1024-d, mean-pools those across windows, L2-normalizes → one 1024-d vector. The orchestrator writes each vector back via `fluncle admin tracks update <trackId> --embedding-file <tmp>`. It prints one JSON summary line.
3. `cron.embed`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … embed-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-embed` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

We deliberately do **not** embed previews (the blind "quiet piano" vectors are the thing this switch to full audio kills) and do **not** embed the `unmatched` capture tail — so a finding with no `source_audio_key` never reaches this sweep, and if one slips through (queue not yet key-gated on the box) it is skipped, never preview-fetched.

## Deploy (on rave-02, one time)

```bash
# 1. Deploy the sweep trio into the container (copy IN via docker cp, like the other box scripts).
docker cp docs/agents/hermes/scripts/embed-sweep.sh  hermes:/opt/data/scripts/
docker cp docs/agents/hermes/scripts/embed-sweep.ts  hermes:/opt/data/scripts/
docker cp docs/agents/hermes/scripts/embed-track.py  hermes:/opt/data/scripts/
docker exec hermes sh -c 'chown 1000:1000 /opt/data/scripts/embed-* && chmod +x /opt/data/scripts/embed-sweep.sh'

# 2. Install the host units.
sudo install -m 0644 docs/agents/hermes/embed-timer/fluncle-embed.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/embed-timer/fluncle-embed.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-embed.timer

# Verify.
sudo systemctl start fluncle-embed.service            # one tick now
journalctl -u fluncle-embed.service -n 40 --no-pager  # expect a { "ok": true, "done": … } summary line
systemctl list-timers fluncle-embed.timer
```

If `fluncle-embed` was previously registered as a Hermes gateway cron, remove it (`hermes cron list` → `hermes cron delete <id>`) so it is not double-scheduled — the host timer is now the sole scheduler.

## Verify peak RAM < 8 GB (gate before enabling)

Before the timer is enabled, box-validate the windowing on a **real ~5-min captured track** and watch peak RSS. The window length + hop are constants in `embed-track.py` (`WINDOW_SECONDS=30`, `HOP_SECONDS=30`, non-overlapping; `MIN_TAIL_SECONDS=10`), overridable via `MUQ_WINDOW_SECONDS` / `MUQ_HOP_SECONDS` for tuning:

```bash
# S3-GET a captured 5-min track to /tmp/full.<ext>, then, inside the container as hermes:
/usr/bin/time -v /opt/muq-venv/bin/python /opt/data/scripts/embed-track.py \
  <<<'[{"id":"probe","path":"/tmp/full.webm"}]'
# Read "Maximum resident set size (kbytes)" — it must stay well under 8 GB (≈ 8388608 KB).
```

Because windows are forwarded sequentially and each window's tensors are freed before the next, peak RSS should track a single ~30s window (≈ the 2.85 GB measured on a 30s preview) plus the model, NOT scale with song length. If a 5-min track approaches the ceiling, lower `MUQ_WINDOW_SECONDS`.

The tick is idempotent + newest-first, so the timer is safe to run as often as the cadence; if it ever stops, `cron.embed` simply goes stale on `/status`. **Re-embedding the 3 preview-proof findings in place** (compute the new full-song vector then overwrite; never null-then-wait) and **enabling this timer** are operator-gated box/data ops (docs/full-audio-rfc.md § Unit 3), held out of this slice.
