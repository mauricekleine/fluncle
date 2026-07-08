# fluncle-embed-timer — the audio-embedding sweep on a host timer

The rave-02 (Hermes box) host trigger for the MuQ audio-**embedding** sweep. `fluncle-embed` embeds each finding's captured full song: S3-GET the `source_audio_key` bytes from the PRIVATE `fluncle-source-audio` R2 bucket, decode to 24 kHz mono, run MuQ over the song in ~30s windows, mean-pool to one 1024-d vector, and write it back via the agent-tier `update_track` op. The vector powers the live `/log` "more like this" row (`get_similar_findings` cosine). This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked sweep script inside the `hermes` container every 5m.

The sweep WORK is BAKED into the image — the `.sh`/`.ts`/`.py` trio at `/opt/hermes-scripts/` (source: [`../scripts/embed-sweep.sh`](../scripts/embed-sweep.sh) → [`../scripts/embed-sweep.ts`](../scripts/embed-sweep.ts) → [`../scripts/embed-track.py`](../scripts/embed-track.py)) plus the MuQ toolchain (`/opt/muq-venv` + the weights baked to `HF_HOME=/opt/muq-cache`). It rides the image and auto-updates from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/hermes-scripts/embed-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` for the R2 creds and execs bun). Unlike capture, embed needs NO `yt-dlp` — it only reads R2 and runs python (torch/MuQ + ffmpeg).

## Why it's a host timer, not a Hermes cron

Embed's per-finding work is **minutes-scale**: the source is the CAPTURED FULL SONG (Unit 3), not the 30s preview, and a windowed MuQ forward over a ~5-min song is ~10 sequential window forwards. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` (and a 120s hard kill otherwise) — a full-song embed would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. So it runs on a **host** systemd timer, exactly like [`fluncle-capture`](../capture-timer/README.md) (whose proxied `yt-dlp` fetch has the same must-not-block-the-fast-sweeps shape), [`fluncle-healthcheck`](../healthcheck-timer/README.md), and [`fluncle-pin-watch`](../pin-watch/README.md): the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow embed can never delay another cron.

`BATCH_CAP=1` (one finding per tick) bounds the wall-clock, and `embed-track.py` **windows** the song so peak RAM is bounded by a single ~30s window's forward, never the whole song. This is verified on the box (see below).

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/embed-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. The container's `embed-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the `fluncle-source-audio` R2 read creds + `R2_ACCOUNT_ID`) and execs the bun orchestrator. The `fluncle` CLI's own admin auth (the queue read + the vector write-back) uses the `FLUNCLE_API_TOKEN` the container env carries.
2. `embed-sweep.ts` reads the embed queue (`fluncle admin tracks embed --queue --json`), which gates server-side on `source_audio_key IS NOT NULL AND embedding_json IS NULL`. The `sourceAudioKey` reaches the sweep because the **admin** DTO carries it unstripped (public reads run `toPublicTrackListItem` and lose it — see [`apps/web/src/lib/server/tracks.ts`](../../../../apps/web/src/lib/server/tracks.ts)) and the CLI's `mapTrack` passes it through. It takes up to `BATCH_CAP` (1) and per finding: S3-GETs the `source_audio_key` bytes from `fluncle-source-audio` to a temp file, then hands a manifest to ONE `embed-track.py` call. `embed-track.py` decodes with ffmpeg, windows into non-overlapping ~30s chunks, MuQ-forwards each sequentially (freeing its tensors between windows), mean-pools each window over time → 1024-d, mean-pools those across windows, L2-normalizes → one 1024-d vector. The orchestrator writes each vector back via `fluncle admin tracks update <trackId> --embedding-file <tmp>`. It prints one JSON summary line.
3. `cron.embed`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … embed-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-embed` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

We deliberately do **not** embed previews (the blind "quiet piano" vectors are the thing this switch to full audio kills) and do **not** embed the `unmatched` capture tail — so a finding with no `source_audio_key` never reaches this sweep (the server key-gate excludes it), and if one ever slipped through it is skipped, never preview-fetched.

## Deploy (on rave-02, one time)

The image bake (Unit A) puts the sweep trio + the MuQ venv/weights in place under `/opt/hermes-scripts/` + `/opt/muq-venv` + `/opt/muq-cache`; you only install the host units. Do all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/embed-timer/fluncle-embed.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/embed-timer/fluncle-embed.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-embed.timer

# Verify.
sudo systemctl start fluncle-embed.service            # one tick now
journalctl -u fluncle-embed.service -n 40 --no-pager  # expect a { "ok": true, "done": 1, … } summary line
systemctl list-timers fluncle-embed.timer
```

pin-watch's pre-smoke guards the embed engine on every rebuild — it resolves `/opt/muq-venv/bin/python` and runs `import torch, muq`, so a rebuild that ships a broken MuQ stack fails pre-smoke and rolls back instead of swapping in a dead embedder. **Enabled + live on rave-02 since 2026-07-08.**

## Peak RAM (gate before enabling) — measured 2026-07-08: ~2.5 GiB, PASS

The window length + hop are constants in `embed-track.py` (`WINDOW_SECONDS=30`, `HOP_SECONDS=30`, non-overlapping; `MIN_TAIL_SECONDS=10`), overridable via `MUQ_WINDOW_SECONDS` / `MUQ_HOP_SECONDS` for tuning. The container has no `/usr/bin/time`, so peak RSS is measured by sampling the container's cgroup live usage while a real sweep runs:

```bash
# In one shell: sample the container's cgroup live usage, keep the max.
while :; do docker exec hermes cat /sys/fs/cgroup/memory.current; sleep 0.3; done | sort -n | tail -1
# In another: run one real embed tick.
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/embed-sweep.sh
```

On a real captured full song, **peak container `memory.current` was ~2518 MiB (~2.5 GiB)** against a ~136 MiB idle baseline — well under the box's 8 GB (≈ 7.6 GiB available), leaving ~5 GiB of headroom. Because windows are forwarded sequentially and each window's tensors are freed before the next, peak RSS tracks a single ~30s window's forward plus the model, NOT song length — a 3-min and a 6-min capture peak the same. If a future model or window change ever approaches the ceiling, lower `MUQ_WINDOW_SECONDS`.

The tick is idempotent + newest-first (an embedded finding is already out of the `embedding_json IS NULL` queue; re-running never double-writes), so the timer is safe to run as often as the cadence; if it ever stops, `cron.embed` simply goes stale on `/status`. The queue drains at `BATCH_CAP=1` per 5-minute tick, newest-first, alongside fresh captures.
