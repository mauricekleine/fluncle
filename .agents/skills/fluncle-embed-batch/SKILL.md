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

The on-box `fluncle-embed` sweep embeds ~a dozen tracks a day on rave-02's CPU. That is fine for the certified archive (Fluncle finds ~15 tracks a _week_) and hopeless for the catalogue, which arrives in the thousands. A catalogue track with no MuQ vector is a track **The Ear cannot hear at all** — it can't be ranked, recommended, or found by "sounds like". So the backlog is worked down in **batches**, off-box, when embedding is the throttle — and an agent can drive either path end to end.

This is the same job in a bigger shape: `embed-batch.ts` takes tracks off the **same** `list_track_work?kind=embed` queue, pulls their audio from private R2, embeds them, and writes the vectors back through the **same** agent-tier API. Two places to run it:

| Target                  | Speed                                             | Cost              | Best for                                                         |
| ----------------------- | ------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| **M5 (this Mac, CPU)**  | ~1,100+/overnight (~2.5/min, measured 2026-07-27) | free (owned)      | backlogs up to a few thousand; no provisioning, run it and sleep |
| **RunPod GPU (rented)** | ~21/min (~1,300/hr)                               | paid, by the hour | large backlogs (many thousands) you want cleared fast            |

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

Free, unmetered, ~1,100+ tracks a night on the M5's CPU (2.47/min measured on the 2026-07-27 run, queue_dry after 1,119). The right default for a backlog of a couple thousand or less. Because it's not billed, over-provision `--minutes` — the run stops on its own when the queue is dry.

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

Paid, fast, for large backlogs. **An agent drives this end-to-end** — provision, run, monitor, destroy — because a `RUNPOD_API_KEY` lives in the vault next to the other secrets (concrete `op://` path: the private companion runbook). Earlier versions of this skill said a pod could only be rented by hand; that is no longer true, and the dashboard is not part of the loop. The architecture is [`docs/gpu-batch-embed.md`](../../../docs/gpu-batch-embed.md); this is the operating procedure.

Everything below was measured on a live run, 2026-07-26. The traps are the expensive part — a pod that is up and billing but silently doing nothing looks exactly like a pod that is working.

**The short version, when the ask is just "drain the embed queue on RunPod".** Read `RUNPOD_API_KEY` + the four embed secrets from `op` (one biometric approval), size the queue, then:

1. `POST https://rest.runpod.io/v1/pods` with the body below — no `dockerStartCmd`, `PUBLIC_KEY` set, the four secrets in `env`.
2. Poll **GraphQL** for `runtime.ports` → the `privatePort: 22` entry; SSH in with `-o IdentitiesOnly=yes -o IdentityAgent=none`.
3. On the pod: `curl -fsSL <raw embed-batch.sh> | bash -s -- --minutes 540`. It installs everything, runs the **preflight** (torch/transformers/numpy/muq must agree — it exits non-zero with the fix if they don't), warms the weights, and runs the batch.
4. Start the **detached** queue-poll monitor that `DELETE`s the pod on drain, then walk away.
5. When it drains: `fluncle admin catalogue rank --limit 250 --json` until `remaining` is 0.

Expect ~21 tracks/min and roughly `queued ÷ 1,300` hours of GPU. Everything after this line is the why, and the traps if a step misbehaves.

### The API: two endpoints, split by job

| Need                                | Where                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| create / status / **destroy** a pod | REST `https://rest.runpod.io/v1/pods` (`POST`, `GET /{id}`, `DELETE /{id}`)          |
| list GPU types + prices             | **GraphQL only** — `POST https://api.runpod.io/graphql`, query `gpuTypes`            |
| real uptime + the mapped SSH port   | **GraphQL only** — `pod(input:{podId})  { runtime { uptimeInSeconds ports { … } } }` |
| container logs                      | nowhere — **there is no logs API**. SSH is the only way to see inside.               |

Both take `Authorization: Bearer $RUNPOD_API_KEY`. Two shape traps: REST has **no** `gpu-types` path, and REST's `runtime` field reads `null` on a pod that is perfectly alive — read uptime from GraphQL or you will diagnose a healthy pod as dead.

### Pick the GPU

MuQ-large is ~300M params and the job is download- and VRAM-bound, not FLOPs-bound, so cheapest-with-enough-VRAM wins. Anything ≥16 GB is plenty; an **RTX A5000 (24 GB)** was the sweet spot at ~$0.16–0.27/hr. Pass several ids in `gpuTypeIds` (priority order) so provisioning falls through when the cheap one is unavailable.

### Create the pod — let the image start itself

```jsonc
{
  "name": "fluncle-embed-batch",
  "imageName": "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04",
  "gpuTypeIds": ["NVIDIA RTX A5000", "NVIDIA RTX A4000", "NVIDIA GeForce RTX 3090"],
  "gpuCount": 1,
  "containerDiskInGb": 60,
  "volumeInGb": 20,
  "interruptible": false,
  "ports": ["22/tcp"],
  "env": {
    "PUBLIC_KEY": "<an ssh pubkey>",
    "FLUNCLE_API_TOKEN": "…",
    "R2_ACCOUNT_ID": "…",
    "FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID": "…",
    "FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY": "…",
    "MUQ_DEVICE": "cuda",
    "MUQ_WINDOW_BATCH": "8",
  },
}
```

**Do not pass `dockerStartCmd`.** It replaces the template's own CMD — which is what installs `PUBLIC_KEY` and starts `sshd` — so the batch runs with no shell and no logs, and a failure is indistinguishable from slow progress. Let the image boot normally, then SSH in and launch the batch yourself. That one decision is the difference between a diagnosable run and a blind one.

### Get in, and find the secrets

`ssh -i <key> -p <publicPort> root@<ip>` using the port from the GraphQL `ports` entry with `privatePort: 22`. Add `-o IdentitiesOnly=yes -o IdentityAgent=none`, or a loaded agent offers every key first and the pod drops you with `Too many authentication failures`.

Then the trap that stops the run dead: **the injected env vars are not in your SSH shell.** They live in **PID 1's** environment, and `/etc/rp_environment` holds only RunPod's own `RUNPOD_*` vars. Import them:

```bash
while IFS= read -r -d '' kv; do case "$kv" in FLUNCLE_*|R2_*|MUQ_*) export "$kv";; esac; done < /proc/1/environ
```

### Run it

```bash
export PATH="$HOME/.bun/bin:$PATH" PYTHON_BIN=python3 MUQ_DEVICE=cuda MUQ_WINDOW_BATCH=8
cd /workspace/fluncle
bun docs/agents/hermes/scripts/embed-batch.ts --minutes 540 --dry-run   # gate: expect queued ~N
nohup bun docs/agents/hermes/scripts/embed-batch.ts --minutes 540 > /workspace/embed-run.log 2>&1 &
```

Confirm with `grep -c ': embedded' /workspace/embed-run.log` climbing within ~2 min. Use `embed-batch.sh` (the bootstrap curl) for a cold pod — it installs ffmpeg, bun, muq, clones the repo, and pre-warms the ~1 GB of MuQ weights. If you install by hand instead, **pin `transformers==4.40.2` and `numpy<2`**: `muq` leaves both unpinned, and on this image transformers 5.x (needs torch ≥ 2.2) dies with `NameError: name 'torch' is not defined` while numpy 2.x breaks the decode path with `_ARRAY_API not found`. Neither fails at install time — the run just never embeds. The bootstrap now pins them; a hand-rolled `pip install muq` still walks into it.

### Monitor from the Mac, and make the destroy session-proof

You cannot read the pod's log without SSH, but you do not need to: the **embed queue count is the progress bar**, and it is authoritative. Poll `list_track_work?kind=embed&count=true` and compare against the baseline you started from — noting that the queue also _climbs_ on its own as the analysis sweep feeds it, so judge progress relative to baseline, never by "the number went up".

Run the poll loop as a **detached process that holds the `DELETE`**, so the pod dies even if the session ends: bill stops on `DELETE`, not when the batch process exits. Give it a drained-exit (queue at floor), a plateau guard, and a never-started abort — but **set never-started well above an hour**. Cold setup (image pull + apt + bun + muq + weights) legitimately takes tens of minutes before the first embed, and a 45-minute abort will execute a healthy pod just as it gets going.

### The GPU is not the bottleneck — the downloads are

Sampled during a live run, the GPU sat at **0% utilization seven samples out of eight**, spiking to ~16% and ~1.5 GB VRAM in short bursts between long waits on R2. The pod spends most of its life fetching audio, which is why a cheap 16–24 GB card is genuinely enough and why a beefier one buys you almost nothing. If a run needs to go faster, raise `FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY` (12 was comfortable) before reaching for a bigger GPU — and remember the pod bills the idle time either way.

### `--minutes` and the clock

The run is clock-bound: it keeps pulling pages until the queue is dry or the budget is spent. With API-driven teardown the monitor destroys the pod the moment the queue drains, so set `--minutes` as a generous **backstop** above the expected drain (`remaining ÷ tracksPerMinute`) rather than trimming it to an hour boundary. `--minutes 540` for an overnight-sized backlog is fine; the pod will not outlive the work.

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
- **The run is clock-bound, not queue-bound** — on RunPod set `--minutes` as a backstop and let the monitor destroy on drain; on the unmetered M5 over-provision and let it dry out.
- **A silent pod looks exactly like a working pod** — RunPod has no logs API, and a bootstrap that died still leaves the pod `RUNNING` and billing. Never infer health from pod status; infer it from the embed queue falling, or from the log over SSH.
- **`dockerStartCmd` buys you a blind pod** — it replaces the template CMD that starts `sshd`, so you lose the only way in. Let the image boot itself and launch the batch over SSH.
- **The pod's env is in PID 1, not your shell** — SSH in and the injected secrets are simply absent (`/etc/rp_environment` only carries RunPod's own vars). Import from `/proc/1/environ`.
- **`pip install muq` resolves deps that break the image** — unpinned, it takes transformers 5.x and numpy 2.x, both fatal against the template's torch 2.1, and neither errors at install time. The bootstrap pins `transformers==4.40.2` + `numpy<2`; keep the pins if you touch it.
- **Do not abort a slow start too early** — cold setup runs tens of minutes before the first embed. A 45-minute never-started guard killed a healthy pod mid-warmup on the first attempt.
- **Always resumable** — an embedded track leaves the `embedding_blob IS NULL` queue and write-back is per-track, so a reclaimed pod or a slept Mac loses nothing. Just launch again.
- **The batch can only measure, never speak** — it sends `{ embedding }` and nothing else; the certification rail 409s anything that would make Fluncle _say_ something about a track. Safe to run against uncertified catalogue rows all day.

## Where the concrete detail lives

- Architecture + the clock-bound design: [`docs/gpu-batch-embed.md`](../../../docs/gpu-batch-embed.md).
- The scripts: `docs/agents/hermes/scripts/embed-batch.ts` (orchestrator), `embed-batch.sh` (pod bootstrap), `embed-track.py` (the one inference script, CPU + GPU).
- **Secrets & topology** (exact `op://` paths, the M5 muq-venv path, the box secrets item): the embed section of `~/Projects/fluncle-labs/docs/ops-runbook.md` in the **private companion**. This skill stays at procedure + placeholders because this repo is world-readable.
