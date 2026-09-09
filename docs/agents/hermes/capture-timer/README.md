# fluncle-capture-timer — the full-song capture sweep on a host timer

The rave-02 (Hermes box) host trigger for the full-song **capture** sweep. `fluncle-capture` captures a track's full song once — `yt-dlp` a YouTube match through a residential proxy on a per-track sticky session, duration-guard it against the row's Spotify length, store the bytes in the PRIVATE `fluncle-source-audio` R2 bucket, then reconcile the key + status through the agent-tier capture receipt seam. It is CATALOGUE-AWARE: the worklist serves certified findings first and then the catalogue by `capture_priority`, and a shut capture budget narrows it to the findings rather than to nothing ([docs/gpu-batch-embed.md](../../../gpu-batch-embed.md)). It is a NON-BLOCKING side-channel that never gates the enrich/embed queues. This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked sweep script inside the `hermes` container every 5m.

The sweep WORK is BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/capture-sweep.sh`](../scripts/capture-sweep.sh) → [`../scripts/capture-sweep.ts`](../scripts/capture-sweep.ts)) plus the PINNED `yt-dlp` fetcher at `/opt/hermes-scripts/yt-dlp`. Both ride the image and auto-update from `main` via the hourly pin-watch rebuild (Unit A/D) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/hermes-scripts/capture-sweep.sh` runs (it sources `${HOME}/.fluncle-secrets.env` and execs bun).

## Why it's a host timer, not a Hermes cron

Capture's per-finding work has an **unbounded tail**: it spawns `yt-dlp` against a residential proxy (a 60s search + up to a 180s download) for up to `BATCH_CAP` findings a tick. On the one serial Hermes `--no-agent` gateway runner — with its ~300s global `script_timeout` — a worst-case tick during the whole-archive backfill drain would blow the budget and **serialize behind / delay the latency-sensitive 5-minute sweeps** (enrich, context-note, note) it shares the runner with. A prober that starves the enrich sweep is exactly the failure the [`fluncle-healthcheck`](../healthcheck-timer/README.md) move fixed; capture has the same shape (long, tail-latent work that must not queue behind — or ahead of — the fast app sweeps), so it runs on a **host** systemd timer for the same reason: the host scheduler is never busy with Fluncle's app work, so the tick always fires on time, and a slow download can never delay another cron. (Same reasoning as [`fluncle-pin-watch`](../pin-watch/README.md) — a container can't cleanly rebuild itself — and the rave-01 watchdog.)

## What a run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/capture-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. The container's `capture-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (the AGENT `FLUNCLE_API_TOKEN`, the residential-proxy creds, the `fluncle-source-audio` R2 creds, `R2_ACCOUNT_ID`) and execs the bun orchestrator.
2. `capture-sweep.ts` opens short database-admitted child phases for the CATALOGUE-AWARE queue read and a fresh per-row prepare. The expensive `yt-dlp`, fingerprint, R2, and server-side oEmbed work runs after that phase has released its lease. Before the first billed capture or provenance provider request it atomically fsyncs a per-track intent under `${HOME}/.fluncle-capture-progress`; a restart protects that row before reading fresh work. A known failed result settles through the normal failure receipt, while a completed provider verdict and its exact local-file digest are journaled before the caller persists the terminal capture or provenance result. Recovery can finish that proven local result without another provider request. Re-verdict has no box-side paid request: its exact result journal is durable before the Worker performs oEmbed. After a capture's R2 PUT, the sweep commits through a snapshot-bound operation receipt. An unknown commit response reconciles the complete digest-bound receipt envelope and HEADs the deterministic R2 key before any repeat, so an object PUT or committed counter is not repeated. Prepare, resolve, and commit accept only their complete bounded success variants; a malformed 2xx response remains pending and cannot erase an intent or result journal. The atomic commit re-checks capture status, rejection memory, provenance, and eligibility against the prepared state; a newer operator or sweep result wins. It prints one JSON summary line with confirmed, failed, and pending writes separated.

**Provider interruption boundary.** The `yt-dlp` search/download interface exposes no idempotency key, request receipt, or remote lookup that can prove whether a killed request reached the provider. The durable intent therefore chooses no duplicate spend over automatic liveness: after a process or host death during an unconfirmed call, recovery never reissues provider work for the row. A completed provider marker plus its exact hash-checked local `audio.<ext>` file is sufficient to continue capture or full-download provenance without rebuying. A file without that marker does not prove that ranking, duration, and fingerprint acceptance completed; it remains an explicit ambiguous hold until a newer snapshot makes it stale or an operator inspects and clears it. The catalogue provenance ladder uses the same intent before its first search, settles known terminal and failed outcomes through receipts, and explicitly clears a normal budget deferral. No terminal provider verdict is invented from an ambiguous call.

3. `cron.capture`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir under `~/.hermes/cron/output/` — `docker exec … capture-sweep.sh` writes there like any Hermes job, so the prober tracks it by the `fluncle-capture` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

**Fencing boundary.** Database admission contains the queue, prepare, reconcile, and commit child processes; the host heartbeat/watchdog stops further local work after lease loss. Capture HTTP requests do not carry the admission lease coordinates, so an already-issued Worker request may still finish after that local lease is lost. Safety across that interval comes from the operation receipt and the commit transaction's current-snapshot checks: an ambiguous response is reconciled before replay, and changed capture status, rejection memory, provenance, or eligibility rejects the older result. This is not a claim of fleet-wide transaction fencing.

`yt-dlp` is **baked PINNED** (`2026.07.04`) at `/opt/hermes-scripts/yt-dlp` — an early Dockerfile layer above the frequently-bumped pins, on the sweep's PATH — and `ffprobe` (ffmpeg) is in the image. Both ride the image, so a rebuilt box has them already. Freshen `yt-dlp` when YouTube's bot-walls move by bumping the pin in the Dockerfile (a repo change that auto-deploys on the next pin-watch rebuild) — no hand-copied persistent-volume binary.

## Coordinated phased-admission rollout

The phased sweep and its host service are one compatibility unit. The older service wraps the whole sweep in `database-admission-runner.sh`, while the phased image reacquires admission around its own short child windows; combining that older unit with the phased image nests leases and can stall. Pin-watch rebuilds the image but does not install changed host units, so an image rebuild alone is not a safe rollout.

For this transition, record whether `fluncle-capture.timer` is enabled and active, stop the timer, and let any active `fluncle-capture.service` finish. With capture quiescent, deploy the compatible Worker contract and phased image. Then use the roster-derived installer to refresh exactly `fluncle-capture.service` and `fluncle-capture.timer`; its refresh mode replaces the selected units and reloads systemd without changing their enabled or active state:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh \
  --refresh-unit fluncle-capture.service \
  --refresh-unit fluncle-capture.timer
```

Inspect the installed service to confirm it invokes `capture-sweep.sh` directly, without a whole-lifetime admission wrapper. Restore the timer to the enabled and active state recorded before the rollout, then run one attended tick and inspect its journal. If any compatible Worker, image, or unit leg is unavailable, keep the timer stopped; do not run a mixed generation.

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
