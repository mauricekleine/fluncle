# fluncle-embed-timer — the audio-embedding sweep on a host timer

The rave-02 (Hermes box) host trigger for the MuQ audio-**embedding** sweep. `fluncle-embed` embeds each finding's captured full song: S3-GET the `source_audio_key` bytes from the PRIVATE `fluncle-source-audio` R2 bucket, decode to 24 kHz mono, run MuQ over the song in ~30s windows, mean-pool to one 1024-d vector, and write it back via the agent-tier `update_track` op. The vector powers the live `/log` "more like this" row (`list_similar_tracks` cosine). This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked sweep script inside the `hermes` container every 5m.

The sweep WORK is BAKED into the image — the `.sh`/`.ts`/`.py` trio at `/opt/hermes-scripts/` (source: [`../scripts/embed-sweep.sh`](../scripts/embed-sweep.sh) → [`../scripts/embed-sweep.ts`](../scripts/embed-sweep.ts) → [`../scripts/embed-track.py`](../scripts/embed-track.py)) plus the MuQ toolchain (`/opt/muq-venv` + the weights baked to `HF_HOME=/opt/muq-cache`). It rides the image and auto-updates from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/hermes-scripts/embed-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` for the R2 creds and execs bun). Unlike capture, embed needs NO `yt-dlp` — it only reads R2 and runs python (torch/MuQ + ffmpeg).

## Why it's a host timer, not a Hermes cron

Embed's per-finding work is **minutes-scale**: the source is the CAPTURED FULL SONG (Unit 3), not the 30s preview, and a windowed MuQ forward over a ~5-min song is ~10 sequential window forwards. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` (and a 120s hard kill otherwise) — a full-song embed would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. So it runs on a **host** systemd timer, exactly like [`fluncle-capture`](../capture-timer/README.md) (whose proxied `yt-dlp` fetch has the same must-not-block-the-fast-sweeps shape), [`fluncle-healthcheck`](../healthcheck-timer/README.md), and [`fluncle-pin-watch`](../pin-watch/README.md): the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow embed can never delay another cron.

`BATCH_CAP=1` (one finding per tick) bounds the wall-clock, and `embed-track.py` **windows** the song so peak RAM is bounded by a single ~30s window's forward, never the whole song. This is verified on the box (see below).

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/embed-sweep.sh` (the in-container work runs as the unprivileged `hermes` user). The unit starts the sweep directly, and the orchestrator holds the single database write lease only around its database windows:

1. The container's `embed-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the `fluncle-source-audio` R2 read creds, `R2_ACCOUNT_ID`, and the agent-scoped `FLUNCLE_API_TOKEN`) and execs the bun orchestrator.
2. **Worklist window (admitted).** `embed-sweep.ts` runs one `database-admission-runner.sh phase fluncle-embed` window around a direct-HTTP read of `GET /api/v1/admin/tracks/work?kind=embed&scope=all` (the box CLI is a pinned release, so the catalogue-aware worklist stays on HTTP). The queue gates server-side on a captured `source_audio_key`, `has_embedding = 0`, and a capture not quarantined as `wrong-audio`, and the admin DTO carries `sourceAudioKey`. A typed `due_work_maintenance_pending` answer ends the tick inside this window as a paused, exit-zero run with `reason: "due_work_repair_pending"`.
3. **Fetch and inference (no lease).** For up to `BATCH_CAP` (1) tracks it S3-GETs the `source_audio_key` bytes to a temp file, then hands a manifest to ONE `embed-track.py` call. `embed-track.py` decodes with ffmpeg, windows into non-overlapping ~30s chunks, MuQ-forwards each sequentially (freeing its tensors between windows), mean-pools each window over time → 1024-d, mean-pools those across windows, L2-normalizes → one 1024-d vector. No database lease is held for any of it, so the projection-maintenance timer and every other admitted writer keep their turn while MuQ runs.
4. **One write window per result (admitted).** Each vector gets its own window: `fluncle admin tracks update <trackId> --embedding-file <tmp>` exactly once, then that result's self-seconds cost row. The run prints one JSON summary line.
5. `cron.embed`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … embed-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-embed` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

**No write is replayed.** `track.embed` is deliberately non-replayable in the [database operation registry](../../../../apps/web/src/lib/server/database-operation-registry.ts): every accepted vector write mints a fresh catalogue-rank material revision and appends a Sonar artifact change, so repeating one is never a no-op. A failed update, including a transport failure whose outcome is unknown, counts as `skipped` and is never re-issued in the tick. A write window that yields (exit 75, whether the command never started or its lease was fenced mid-flight) stops the run with `gateState: "paused"`, `reason: "database_admission"`, `partial: true`, the measured `done` and `embedFailed` counts, and every unapplied result in `writesPending`. The next tick's admitted worklist read is the durable fence: a landed write set `has_embedding = 1` and the track is gone, while an unlanded one is still queued and is recomputed.

We deliberately do **not** embed previews (the blind "quiet piano" vectors are the thing this switch to full audio kills) and do **not** embed the `unmatched` capture tail — so a finding with no `source_audio_key` never reaches this sweep (the server key-gate excludes it), and if one ever slipped through it is skipped, never preview-fetched.

## Rollout order: image first, then the unit

The phased script and this unit ship in one change but reach the box in two steps, and the order matters:

1. **Image first.** Pin-watch rebakes the image from `main`, which puts the phased `embed-sweep.ts` at `/opt/hermes-scripts/`. An installed unit that still wraps the sweep in `database-admission-runner.sh fluncle-embed -- …` exports `FLUNCLE_ADMISSION_RUNNER_PID` to it, and the phased script then runs its windows in-process under that single inherited lease instead of nesting phase admission, so that pairing behaves like the whole-lifetime sweep. Before the next step, confirm the image carries the phased script: `docker exec hermes grep -c runDatabaseAdmissionPhase /opt/hermes-scripts/embed-sweep.ts` prints a non-zero count.
2. **Then refresh the unit.** Replace exactly the service with the roster-derived installer. Its refresh mode reloads systemd without changing the timer's enabled or active state, and the `.timer` itself is unchanged:

   ```bash
   sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-embed.service
   ```

   Confirm with `systemctl cat fluncle-embed.service` that it starts `embed-sweep.sh` directly, then run one attended tick and read its journal: expect `phase_scoped:true` runner events for the worklist and write windows, and no lease spanning the MuQ inference.

Never install this unit before the image: the older script under the new unit would run with no database admission at all.

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

pin-watch's pre-smoke guards the embed engine on every rebuild — it resolves `/opt/muq-venv/bin/python` and runs `import torch, muq`, so a rebuild that ships a broken MuQ stack fails pre-smoke and rolls back instead of swapping in a dead embedder. An import cannot see a dependency that breaks inference past import (transformers 5.16+ against muq 0.1.0 imports and loads weights, then fails every track), so the image build itself runs one MuQ forward over a second of silence — the Dockerfile's bake smoke — and such a rebuild fails at `docker build`, leaving the box on its current image. **Enabled + live on rave-02 since 2026-07-08.**

## Peak RAM (gate before enabling) — measured 2026-07-08: ~2.5 GiB, PASS

The window length + hop are constants in `embed-track.py` (`WINDOW_SECONDS=30`, `HOP_SECONDS=30`, non-overlapping; `MIN_TAIL_SECONDS=10`), overridable via `MUQ_WINDOW_SECONDS` / `MUQ_HOP_SECONDS` for tuning. The container has no `/usr/bin/time`, so peak RSS is measured by sampling the container's cgroup live usage while a real sweep runs:

```bash
# In one shell: sample the container's cgroup live usage, keep the max.
while :; do docker exec hermes cat /sys/fs/cgroup/memory.current; sleep 0.3; done | sort -n | tail -1
# In another: run one real embed tick.
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/embed-sweep.sh
```

On a real captured full song, **peak container `memory.current` was ~2518 MiB (~2.5 GiB)** against a ~136 MiB idle baseline — well under the box's 8 GB (≈ 7.6 GiB available), leaving ~5 GiB of headroom. Because windows are forwarded sequentially and each window's tensors are freed before the next, peak RSS tracks a single ~30s window's forward plus the model, NOT song length — a 3-min and a 6-min capture peak the same. If a future model or window change ever approaches the ceiling, lower `MUQ_WINDOW_SECONDS`.

The tick is idempotent (an embedded track is already out of the `has_embedding = 0` queue, and no write is replayed within a tick), so the timer is safe to run as often as the cadence; if it ever stops, `cron.embed` simply goes stale on `/status`. The queue drains at `BATCH_CAP=1` per 5-minute tick in the server's drain order (certified first, then The Ear's capture priority), alongside fresh captures.
