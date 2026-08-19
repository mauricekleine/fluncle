# The audio pipeline at catalogue scale — the work queues + the GPU batch embed

Fluncle's audio pipeline has three stages, and all three are **measurements of a recording**: capture puts the full song in private R2, analysis reads it for BPM/key/features, embedding reads it for the 1024-d MuQ vector. None of them is an opinion. All of them live on `tracks`.

That distinction is the whole of this document. It is what lets the pipeline work a **catalogue track** — a `tracks` row with no `findings` row ([docs/the-ear.md](./the-ear.md)) — and it is what stops the pipeline from ever saying a word about one.

## The work queues

`listTrackWork` (`apps/web/src/lib/server/track-work.ts`) serves all three stages off `tracks`, outer-joined to the certification. One op, one CLI command:

```bash
fluncle admin tracks work --kind embed                      # both halves, in drain order
fluncle admin tracks work --kind analyze --scope catalogue  # the uncertified half only
fluncle admin tracks work --kind capture --json             # whose audio to buy next
fluncle admin tracks work --kind embed --count              # …and how big the backlog actually is
```

A read is a **page**, capped at 200 rows, so its length answers "how many did I get" and never "how much is left" — at catalogue scale those differ by orders of magnitude. `--count` adds `queued`: the whole backlog for that kind and scope. It is opt-in because the 5-minute box sweeps do not need it and should not pay for it; the `embed` predicate is backed by a **partial index** (`tracks_embed_queue_idx`, over exactly the un-embedded rows), which both makes that count cheap and keeps the embed queue read off a full scan of a table whose rows each carry a ~20 KB vector.

| kind      | the worklist                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture` | no audio yet, and the capture state machine still says it is worth trying (`pending`/NULL; a `failed` row only past its cooldown and under the failure cap). A **finding** also needs a coordinate — the R2 key is `<logId>/…`. A **catalogue** row also needs a ranked, non-vetoed tier; it captures under `catalogue/<trackId>/…` (no coordinate exists, and certification later does not re-key — `source_audio_key` is the pointer of record). |
| `analyze` | audio on file, and the stored analysis did not come from it (`analyzed_from <> 'full'`). **Data**-derived, not status-derived — a catalogue row has no `enrichment_status` to drive a queue with.                                                                                                                                                                                                                                                  |
| `embed`   | audio on file, no vector. The captured full song is the only admissible source; a preview vector is garbage (ratified).                                                                                                                                                                                                                                                                                                                            |

### The order is the budget

Audio capture is metered — a residential proxy bills **per GB** — so the order this queue drains in literally decides what the money buys. It is one `ORDER BY`, evaluated in SQL:

Order capture work by certification first, then `capture_priority DESC`, then newest finding and track ID for determinism.

### The veto is a predicate, not a sort

A disabled label has capture priority −1 and is excluded by `capture_priority >= 0`. Its row remains visible for inspection but never reaches the metered capture worker.

It is scoped to **capture alone**, deliberately. A ruling governs what Fluncle _acquires_ ([docs/label-entity.md](./label-entity.md) — a capture **is** an acquisition), not what he may measure. If the bytes are already on file, analysing and embedding them is free, and the resulting vector is how The Ear gets to _disagree_ with the ladder.

### …and the order is not the whole budget

The order decides **what** the metered GB buy. It says nothing about **how much** — and a queue drains whatever it is given, so at catalogue scale that gap is ~1,150 songs (~9 GB) a day, forever. The **capture budget** ([docs/the-ear.md](./the-ear.md) § The capture budget) is the how-much: a default-deny kill switch plus a rolling-24h count/byte cap on the `settings` KV, consulted by `listTrackWork` **before** the `capture` worklist is selected.

It is applied here, at the queue, because this function is the only door a catalogue row can reach a metered download through — so every client obeys it. When the budget is shut the capture worklist **narrows to the findings**, never to nothing: the archive is not starved by the telescope. And like the veto, it gates **capture alone** — bytes already bought are free to analyse and embed.

## The certification rail

One rule, and it is canon: **Fluncle does not speak about a track he has not been to.**

The danger is that `update_track` is a single generic endpoint. The analysis fields (`bpm`, `key`, `features`, `embedding`, the capture side-channel) and the fields that make Fluncle _speak_ (`note`, `contextNote`, the observation, the video, `galaxyId`, `enrichmentStatus`, `logId`) go through the very same call. So `updateTrack` gates on certification:

- an **uncertified** track takes every analysis field, and
- **refuses every certification field** with a `409 uncertified` that names the field.

Return `409 uncertified` before applying any certification field. A zero-row `UPDATE` could otherwise report success without persisting the field.

The publish and video ops need no new gate — they resolve through `requireTrack` → the finding join, so a catalogue track is a 404 there and they cannot so much as name it. The read join and the write rail enforce the same rule from two directions.

Both halves are proven against the real schema in `findings-certification.integration.test.ts`: a catalogue track **can** be analysed, embedded, and given captured audio; it **cannot** get a note, an observation, a video, a publish, a galaxy, a context note, an enrichment status, or a coordinate. A mixed payload (a legal measurement plus an illegal claim) is rejected **whole** — a partial success is how a catalogue track would quietly acquire half a finding.

## The GPU batch

Use the CPU sweep for the low-volume certified archive and the GPU batch for catalogue-scale backlogs. Measure current throughput before sizing a GPU run.

`embed-batch.ts` is the same job in the other shape: take tracks off the **same** queue, pull their audio, embed them on the GPU, write the vectors back through the **same** agent-tier API.

### The run is bounded by the CLOCK, not by the queue

This is the design, and everything else follows from it. **You do not rent 200 tracks. You rent an hour.** A batch that embeds one page and exits leaves the pod idle for the rest of the hour you have already paid for — the entire cost with almost none of the benefit. So the run takes a **time budget** and keeps pulling pages until the queue is dry or the budget is spent.

- **`--minutes N`** (env `FLUNCLE_EMBED_RUN_MINUTES`, default **55**) is the run. It is the number to reach for.
- **`--limit N`** is the **page** — how many tracks ride one `embed-track.py` call. It is not the run size, and it is capped at **100** (see the prefetch below). The default is the cap.

**Pick `--minutes` by the block you rented, minus a margin.** Spilling one minute past an hour boundary buys a whole second hour for one track, so a hand-rented block always stops **short** on purpose:

| you rented | pass                         |
| ---------- | ---------------------------- |
| 1 hour     | `--minutes 55` (the default) |
| 2 hours    | `--minutes 115`              |
| 4 hours    | `--minutes 235`              |

That table is for a block someone rented by hand. When the pod is **API-driven** (the normal case now), the monitor destroys it the moment the queue drains, so the clock stops being the thing you trim to — pass `--minutes` as a generous **backstop** above the expected drain (`remaining ÷ tracksPerMinute`) and let the drain, not the hour, end the run.

Four properties make the hour actually fill, and each is proven with a fake clock and a stubbed GPU in `embed-batch.test.ts`:

**The page is sized to the time that is left.** Each page is cut to `remaining time ÷ observed per-track time` — measured from the pages this run has already done, never a hardcoded guess. A page of audio pulled out of R2 and then abandoned is money paid for nothing, so a page the budget cannot finish is never started.

**The first page is one track — a calibration probe.** Make the first page a one-track calibration probe, then size later pages from its measured per-track duration.

**The next page's audio downloads while the current page is on the GPU.** The pod is remote from R2 and the GPU is the expensive thing in the room, so the R2 pull is overlapped with the inference (`DOWNLOAD_CONCURRENCY` is the parallelism _within_ a page; this is the one _across_ pages, and it is where the throughput is). This is why the page cap is 100 and not the server's 200: the page currently on the GPU has not had its vectors written back yet, so the server still lists those tracks at the head of the queue — the prefetch has to read _past_ them, and a 200-row read cannot see past a 200-row page.

**It is resumable, and it reports honestly.** An embedded track leaves the `source_audio_key is not null and has_embedding = 0` queue and the write-back is per _track_, so a pod reclaimed at track 400 of 500 has 400 vectors safely in the archive and the next run picks up at 401 — nothing is checkpointed because nothing needs to be. And the summary carries **`remaining`**: the size of the whole backlog, **counted server-side** after the write-backs. A run that says "done" while 8,000 tracks are still queued is lying to the person deciding whether to rent another hour.

**It is one inference script, not two.** `embed-track.py` runs both paths, switched by two env knobs:

| knob               | box (CPU)    | pod (GPU)             |
| ------------------ | ------------ | --------------------- |
| `MUQ_DEVICE`       | `auto` → cpu | `cuda`                |
| `MUQ_WINDOW_BATCH` | `1`          | `8`–`16` (VRAM-bound) |

Use the same inference script on CPU and GPU so decode, windowing, pooling, normalization, and vector space remain identical. The windows of a song are independent (each is mean-pooled over its own time axis _before_ the cross-window mean), so stacking them into one `[B, samples]` forward changes nothing about the arithmetic. A short final window is zero-padded to stack, and its mean is taken over its own true frame count, so the padding is never averaged in and a batched run agrees with a sequential one.

**The boundary.** This is the _consumer_ side: given audio already in private R2, embed it. How the bytes got there is a separate concern with its own metered budget and is not this script's business.

### The runbook

An agent provisions, monitors, and destroys the RunPod pod through the API using the vault-provisioned `RUNPOD_API_KEY`.

**The procedure lives in the [`fluncle-embed-batch`](../packages/skills/fluncle-embed-batch) skill, Path B**, and that is the one to follow: it carries the API split (pods are REST, but GPU prices, real uptime and the SSH port are GraphQL-only, and there is no logs endpoint at all), the `dockerStartCmd` trap that leaves you with a billing pod you cannot see into, where the injected secrets actually land, and the detached monitor that holds the destroy so billing stops even if the session dies. What follows here is the shape of the job; the skill is the procedure.

**Dependency pins are load-bearing.** `muq` leaves `transformers` and `numpy` unpinned, so an unconstrained install resolves versions the template's torch cannot carry — and neither failure is loud: transformers quietly disables its torch backend, numpy 2.x only warns at import and breaks the decode path later. Both leave a pod that is up, billing, and never embedding. `embed-batch.sh` pins them and runs a **preflight** that asserts torch, a live transformers torch backend, the numpy↔torch bridge, and the `muq` import before any GPU time is spent. Keep that preflight green rather than trusting the pins to age well.

**Prerequisites.** A RunPod account, and the three secrets the pod needs (all already in the box's secrets item): the agent-scoped `FLUNCLE_API_TOKEN`, and the `fluncle-source-audio` R2 read credentials (`R2_ACCOUNT_ID`, `FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID`, `FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY`). The concrete vault paths live in the private companion repo.

**1 · Size the job before renting anything — and decide how many hours to buy.** `--count` asks for the **whole backlog**, not the page (the page is capped at 200, so counting its rows would tell you nothing about the thousands behind it):

```bash
fluncle admin tracks work --kind embed --count --limit 1 --json | jq '.queued'
```

That number over the throughput of your last run (`tracksPerMinute` in its summary) is how many minutes of GPU the backlog needs. On a first run you have no throughput number yet — rent one hour, read the summary, and size the next block from it.

**2 · Rent the pod.** A single mid-range CUDA GPU is plenty — MuQ-large is a ~300M-parameter encoder and a ~30s window at 24 kHz is a small tensor; the batch is bound by VRAM and by the R2 download, not by FLOPs. Start from RunPod's **PyTorch** template (CUDA + torch preinstalled) and give it disk for **two** pages of audio at once — the prefetch holds the next page while the current one is on the GPU, so budget roughly `2 × page × the size of a full song`.

**3 · Bootstrap the pod.** `embed-batch.sh` (beside the orchestrator) does the whole thing — installs bun, ffmpeg and `muq`, clones the repo, and runs the batch:

```bash
curl -fsSL https://raw.githubusercontent.com/mauricekleine/fluncle/main/docs/agents/hermes/scripts/embed-batch.sh | bash -s -- --minutes 55
```

Or, if you prefer to see each step, run them by hand — the script is short and is the source of truth for what they are.

**4 · Dry-run first.** It answers "what would this run do" **without** starting the GPU and without pulling a single billed byte out of R2 — the backlog, the budget, and the head of the queue:

```bash
bun docs/agents/hermes/scripts/embed-batch.ts --minutes 55 --dry-run
# {"dryRun":true,"minutes":55,"ok":true,"page":100,"queued":8214,"scope":"all"}
```

**5 · Run it — once per rented block.** The run fills the block by itself; you do not re-fire it every 200 tracks. Match `--minutes` to what you rented (see the table above).

```bash
MUQ_DEVICE=cuda MUQ_WINDOW_BATCH=8 bun docs/agents/hermes/scripts/embed-batch.ts --minutes 55
# {"ok":true,"abandoned":0,"catalogue":604,"downloadFailed":0,"downloaded":612,"embedded":610,
#  "failed":2,"findings":8,"minutes":54.2,"pages":8,"remaining":7604,"scope":"all",
#  "stopReason":"budget_spent","tracksPerMinute":11.25,"writeFailed":0}
```

Use `stopReason`, `remaining`, and `tracksPerMinute` to decide whether the run is complete and size any continuation.

- **`stopReason`** — `queue_dry` is the only one that means _done_. `budget_spent` means there is more work and the clock ran out. `queue_blocked` means every remaining row is one this run already tried and could not finish (a dead R2 object, a failing write-back) — look at those tracks rather than renting again. `embed_failed` means the python side died (usually VRAM: lower `MUQ_WINDOW_BATCH`).
- **`remaining`** — the honest backlog, counted server-side after the write-backs.
- **`tracksPerMinute`** — what this pod actually does. `remaining ÷ tracksPerMinute` is the next rental, in minutes.

Re-running after a crash (or a reclaimed spot pod) is always safe: an embedded track leaves the queue, so a second run simply picks up what is left.

**6 · Re-rank, so The Ear can hear them.** New vectors move the corpus fingerprint, so the ranking sweep self-heals — but drive it now rather than waiting:

```bash
fluncle admin catalogue rank --limit 250 --json   # repeat while `remaining > 0`
```

**7 · Destroy the pod.** It bills while it exists, not while it works.

**Tuning.** Raise `MUQ_WINDOW_BATCH` until VRAM complains, then step back one — that is the single biggest lever on `tracksPerMinute`. Raise `FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY` (default 6) if the GPU is still idling between tracks; the cross-page prefetch already hides most of the R2 latency, so reach for this second. `FLUNCLE_EMBED_SAFETY_FACTOR` (default 1.25) is the headroom the page sizer leaves on the measured rate — lower it only if you are watching the run.

**Safety.** The pod holds an **agent**-scoped token and speaks only to the Worker; it never touches the database. It sends `{ embedding }` and nothing else — no status, no note, no coordinate — and the certification rail would 409 it if it tried. The downloaded songs are private audio and are deleted from the pod's disk on every exit path.

## Files

- `apps/web/src/lib/server/track-work.ts` — the three queues, the drain order, the veto predicate, and `countTrackWork` (the honest backlog).
- `apps/web/src/lib/server/track-work.integration.test.ts` — the order + veto + count proofs, on a real engine.
- `docs/agents/hermes/scripts/embed-batch.test.ts` — the clock bound, the page sizer, the prefetch overlap and the resumability, on a fake clock and a stubbed GPU (no pod is ever rented to prove them).
- `apps/web/src/lib/server/track-update.ts` — the certification rail (`CERTIFICATION_FIELDS`).
- `apps/web/src/lib/server/findings-certification.integration.test.ts` — the rail proofs.
- `docs/agents/hermes/scripts/embed-batch.ts` + `embed-batch.sh` — the GPU batch and its pod bootstrap.
- `docs/agents/hermes/scripts/embed-track.py` — the one inference script, CPU and GPU.
- `docs/agents/hermes/scripts/embed-sweep.ts` / `enrich-sweep.ts` / `capture-sweep.ts` — the on-box sweeps, all three catalogue-aware: each reads `list_track_work` for its stage. `capture-sweep.ts` reads `kind=capture&scope=all`, so the budget's brake gates it at the queue; with the brake paused it sees only findings, byte-for-byte as before it was wired.
