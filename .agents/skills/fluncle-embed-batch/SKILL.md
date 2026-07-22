---
name: fluncle-embed-batch
description: >-
  Clear Fluncle's catalogue MuQ embedding backlog by running the embed batch off-box — on the M5 (CPU,
  overnight, free) or a rented RunPod GPU (fast, paid). Use whenever the embed queue is backed up, the
  operator wants more catalogue tracks recommendation-eligible, someone says "run the embed batch", "fire
  the GPU batch", "embed the catalogue", "clear the embed backlog", "MuQ embeddings at scale", "RunPod
  embed", or "overnight embed on the M5" — or when a funnel/health check shows embedding is the bottleneck.
  This is the CATALOGUE-SCALE batch (`embed-batch.ts`), not the per-track BPM/key enrichment (that is
  fluncle-track-enrichment) and not the automatic on-box `fluncle-embed` trickle (that runs itself).
---

# Fluncle embed batch — clear the catalogue embedding backlog

The on-box `fluncle-embed` sweep embeds ~a dozen tracks a day on rave-02's CPU. That is fine for the certified archive (Fluncle finds ~15 tracks a _week_) and hopeless for the catalogue, which arrives in the thousands. A catalogue track with no MuQ vector is a track **The Ear cannot hear at all** — it can't be ranked, recommended, or found by "sounds like". So the backlog is worked down in **batches**, off-box, by the operator, when embedding is the throttle.

This is the same job in a bigger shape: `embed-batch.ts` takes tracks off the **same** `list_track_work?kind=embed` queue, pulls their audio from private R2, embeds them, and writes the vectors back through the **same** agent-tier API. Two places to run it:

| Target                  | Speed                       | Cost              | Best for                                                         |
| ----------------------- | --------------------------- | ----------------- | ---------------------------------------------------------------- |
| **M5 (this Mac, CPU)**  | ~900 / overnight (~1.5/min) | free (owned)      | backlogs up to a few thousand; no provisioning, run it and sleep |
| **RunPod GPU (rented)** | ~11/min (~660/hr)           | paid, by the hour | large backlogs (many thousands) you want cleared fast            |

The M5 runs on **CPU, not the Metal GPU** — `embed-track.py` only branches `cuda` vs `cpu` (`auto` → cpu when there's no CUDA), and that is deliberate: the decode → window → mean-pool → L2-normalize pipeline _is_ the embedding contract, and a second copy of it on a different device is how two vectors of the "same" track silently stop being comparable. Don't add an `mps` path to make the M5 "faster" — you'd fork the vector space.

The deep architecture (why the run is bounded by the **clock** not the queue, the page sizer, the calibration probe, the cross-page prefetch, the certification rail) lives in [`docs/gpu-batch-embed.md`](../../../docs/gpu-batch-embed.md). Read it if you're changing the batch; this skill is the operator runbook for _running_ it.

## Before anything — is embedding actually the bottleneck?

Don't rent a pod or burn a night on a hunch. Size the queue first:

```bash
# the honest backlog (the WHOLE embed queue, not one page):
curl -sS "$FLUNCLE_API_BASE_URL/api/v1/admin/tracks/work?kind=embed&count=true&limit=1" \
  -H "Authorization: Bearer $FLUNCLE_API_TOKEN" | jq '.queued'
```

`/api/v1/admin/funnel` gives the fuller picture — `stages.embedded` vs `stages.captured` (embed lag) and `queues.captureQueue` (what will _become_ embeddable as capture drains). If `embedded` is tracking `captured` closely and rec-eligible is growing fine, embedding isn't your problem — capture or anchoring upstream probably is. Embedding is the bottleneck when the embed queue is deep and rec-eligible growth has flatlined at the on-box trickle rate (~a dozen/day).

## The four env vars (secrets stay in `op`)

Both targets need the same four. **The concrete `op://` item paths and the M5 muq-venv path are operator/topology detail — they live in the private companion runbook, NOT in this public repo.** Read them from `~/Projects/fluncle-labs/docs/ops-runbook.md` (the embed section). Placeholders here:

| env var                                     | what it is                                                                   | source                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `FLUNCLE_API_TOKEN`                         | writes the vectors back (agent-tier is enough; an operator token also works) | `op://<vault>/<token item>/credential` — on an operator machine the `~/l/.env.production` file already has one (see README) |
| `R2_ACCOUNT_ID`                             | the source-audio R2 account                                                  | `op://<vault>/<source-audio R2 item>/account_id`                                                                            |
| `FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID`     | private-bucket read key                                                      | `op://<vault>/<source-audio R2 item>/access_key_id`                                                                         |
| `FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY` | private-bucket read secret                                                   | `op://<vault>/<source-audio R2 item>/secret_access_key`                                                                     |

Plus `PYTHON_BIN` → the muq venv's `python3` (its exact path is in the private runbook; on a RunPod pod the bootstrap script installs muq for you).

**The R2 trap that costs ~40 minutes if you miss it:** the source-audio creds live in the source-audio R2 item's **custom section fields** (`account_id` / `access_key_id` / `secret_access_key`) — the item's template fields (`username` / `credential`) are **empty decoys**, and `op item get | head` truncates the list right before the real ones. And the generic `R2_ACCESS_KEY_ID` from `.dev.vars` is the **public** bucket — it 403s the private source-audio bucket, which shows up as `downloadFailed` = the whole batch and a `queue_blocked` stop. Use the source-audio-specific creds, from the custom fields.

**An AI agent CAN run this end-to-end — this is the whole point of the skill.** `op` authenticates through the 1Password desktop-app integration, so an agent just runs the real `op read '<ref>'` **directly** (with the sandbox OFF, so `op` reaches the app socket) — the command surfaces the biometric prompt on the operator's machine, they approve **once**, and it proceeds (the session is cached for a few minutes, so the follow-up reads don't re-prompt). Two hard rules that waste turns every time they're forgotten:

- **NEVER run `op signin` or `op whoami` first.** In a non-TTY agent shell they _always_ report "account is not signed in" — they do NOT reflect whether `op read` will work, and it will. Skip the check; run the real read.
- **Source the token env file with `set -a`** (`set -a; source ~/l/.env.production; set +a`) — a plain `source` sets `FLUNCLE_API_TOKEN` as a shell var but does NOT export it, so the `bun` child process can't see it and the run aborts `missing_api_token`. (The R2 vars are `export`ed explicitly below, so they're fine either way.)

The one thing genuinely reserved for the operator is the single fingerprint approval on that first `op read`. Everything else — sizing, the reads, the dry-run gate, the launch, the verification, the re-rank — the agent does.

---

## Path A — the M5 overnight run

Free, unmetered, ~900 tracks a night on the M5's CPU. The right default for a backlog of a couple thousand or less. Because it's not billed, over-provision `--minutes` — the run stops on its own when the queue is dry.

Run this directly (agent or operator, **sandbox OFF** so `op` reaches the app socket), from the repo root. The three `op read`s trigger one biometric prompt the operator approves:

```bash
set -a; source ~/l/.env.production; set +a                    # EXPORTS FLUNCLE_API_TOKEN + FLUNCLE_API_BASE_URL
export PYTHON_BIN=<muq venv python — see the private runbook>
export R2_ACCOUNT_ID="$(op read 'op://<vault>/<source-audio R2 item>/account_id')"
export FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID="$(op read 'op://<vault>/<source-audio R2 item>/access_key_id')"
export FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY="$(op read 'op://<vault>/<source-audio R2 item>/secret_access_key')"

# 1) dry-run GATE — confirms creds resolved (queued ~N, NOT missing_r2_credentials / missing_api_token):
bun docs/agents/hermes/scripts/embed-batch.ts --minutes 600 --dry-run

# 2) launch DETACHED so it outlives this shell / the agent session and runs all night:
nohup bun docs/agents/hermes/scripts/embed-batch.ts --minutes 600 </dev/null >~/embed-overnight.log 2>&1 &
disown; echo "$!" > ~/embed-overnight.pid
echo "launched PID $(cat ~/embed-overnight.pid)"
```

**Confirm it's really working** (within ~1–2 min, after the model loads): `grep -c ': embedded' ~/embed-overnight.log` should climb past 0. `missing_r2_credentials` = an `op read` came back empty; `downloadFailed` climbing = the wrong (public) bucket; `missing_api_token` = you dropped the `set -a`.

The **Mac must stay awake** for the night — make sure a `caffeinate` is running (the operator may already have one; if not, prepend `caffeinate -is` to the launch). Plugged in, lid open. Fully resumable, so a sleep or reboot mid-run just picks up where it left off next launch. To drive the re-rank automatically when the run finishes (below), chain a detached watcher that polls `~/embed-overnight.pid` and, on exit, loops `rank_catalogue` — so the whole night is hands-off.

---

## Path B — the RunPod GPU rental

Paid, fast (~11/min), for large backlogs. **Nothing in the repo can start a pod — the operator rents it, runs the batch, and destroys it.** Full step-by-step (rent the PyTorch pod, disk for two pages of audio, the `embed-batch.sh` bootstrap curl, tuning) is the "runbook (operator-fired)" section of [`docs/gpu-batch-embed.md`](../../../docs/gpu-batch-embed.md); the essentials:

1. **Rent the block deliberately** — `remaining ÷ tracksPerMinute` (from a prior run's summary) is the minutes you need. A single mid-range CUDA GPU is plenty (MuQ-large is ~300M params; it's VRAM- and download-bound, not FLOPs-bound).
2. **Bootstrap + run** on the pod, secrets in its env:
   ```bash
   MUQ_DEVICE=cuda MUQ_WINDOW_BATCH=8 bun docs/agents/hermes/scripts/embed-batch.ts --minutes 55
   ```
3. **`--minutes` is the rented block minus a margin** — the run keeps pulling pages until the queue is dry or the clock is spent, and spilling one minute past an hour boundary buys a whole second hour. Stop short on purpose:

   | rented  | `--minutes`    |
   | ------- | -------------- |
   | 1 hour  | `55` (default) |
   | 2 hours | `115`          |
   | 4 hours | `235`          |

4. **Destroy the pod** when the run returns — it bills while it exists, not while it works.

---

## Reading the result (both targets)

The summary is one JSON line. Read the last three fields and nothing else:

- **`stopReason`** — `queue_dry` is the only one that means _done_. `budget_spent` = more work, the clock ran out (size the next block from `remaining`). `queue_blocked` = every remaining row is one this run already tried and couldn't finish (a dead R2 object, a failing write-back) — look at those tracks rather than launching again. `embed_failed` = the python side died, usually VRAM: lower `MUQ_WINDOW_BATCH`.
- **`remaining`** — the honest backlog, counted server-side _after_ the write-backs. Trust this over any "done" feeling.
- **`tracksPerMinute`** — what this machine actually did. `remaining ÷ tracksPerMinute` sizes the next run.

## After the run — re-rank so The Ear can hear them

New vectors move the corpus fingerprint, so the ranking sweep self-heals on its own schedule — but drive it now rather than waiting a day:

```bash
fluncle admin catalogue rank --limit 250 --json    # repeat while the ranker reports remaining > 0
```

An embedded-but-unranked track is in the archive but not yet placed in The Ear's ordering, so it won't surface in recommendations or "sounds like" until this runs. This is the step that turns "embedded" into "recommendation-eligible".

## Pitfalls, collected

- **The M5 embeds on CPU by design** — no `mps` path. Faster-looking on paper, but a different device drifts the vectors out of the shared space. Leave it.
- **Wrong R2 creds → silent 403** — the generic `.dev.vars` R2 key is the public bucket; `downloadFailed` = batch size and `queue_blocked` is the tell. Use the source-audio R2 item's custom fields.
- **`missing_r2_credentials`** is an empty env var (an `op read` returned nothing), never a code bug — the dry-run catches it before you commit a night or an hour.
- **The run is clock-bound, not queue-bound** — on RunPod stop short of the hour boundary; on the unmetered M5 over-provision and let it dry out.
- **Always resumable** — an embedded track leaves the `embedding_json IS NULL` queue and write-back is per-track, so a reclaimed pod or a slept Mac loses nothing. Just launch again.
- **The batch can only measure, never speak** — it sends `{ embedding }` and nothing else; the certification rail 409s anything that would make Fluncle _say_ something about a track. Safe to run against uncertified catalogue rows all day.

## Where the concrete detail lives

- Architecture + the clock-bound design: [`docs/gpu-batch-embed.md`](../../../docs/gpu-batch-embed.md).
- The scripts: `docs/agents/hermes/scripts/embed-batch.ts` (orchestrator), `embed-batch.sh` (pod bootstrap), `embed-track.py` (the one inference script, CPU + GPU).
- **Secrets & topology** (exact `op://` paths, the M5 muq-venv path, the box secrets item): the embed section of `~/Projects/fluncle-labs/docs/ops-runbook.md` in the **private companion**. This skill stays at procedure + placeholders because this repo is world-readable.
