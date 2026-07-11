# The audio pipeline at catalogue scale — the work queues + the GPU batch embed

Fluncle's audio pipeline has three stages, and all three are **measurements of a recording**: capture puts the full song in private R2, analysis reads it for BPM/key/features, embedding reads it for the 1024-d MuQ vector. None of them is an opinion. All of them live on `tracks`.

That distinction is the whole of this document. It is what lets the pipeline work a **catalogue track** — a `tracks` row with no `findings` row ([docs/the-ear.md](./the-ear.md)) — and it is what stops the pipeline from ever saying a word about one.

## What the split left behind

`tracks` and `findings` were split in two ([docs/track-lifecycle.md](./track-lifecycle.md)); the analysis columns went to `tracks`, where they belong. The three sweeps did not move with them.

Every one of them read its worklist off `listTracks` — the **feed** engine — through `FINDINGS_FROM`, an **inner join** onto the certification. Post-split that join is a silent filter. A catalogue track was structurally invisible to capture, to analysis, and to embedding: it could never get a vector, and The Ear ranks the catalogue **by** its vector, so the feature it was built for had nothing to rank. The write-back was blind the same way — `updateTrack` resolved through the same join, so a `bpm` or `embedding` PATCH on a catalogue track **404'd**.

Two more things fell out of the audit:

- **`capture_priority` was written and read by nothing.** The Ear's sweep computed the pre-audio ladder onto every catalogue row, and no queue consumed it. The capture queue drained newest-first — insertion order — while the signal that says _whose audio is worth buying_ sat unused on the row.
- **The veto could not be enforced.** `skipped-label` (the operator ruled this label out) and `none` (nothing ties this to the archive) both stored tier **0**, so SQL could not tell them apart. A veto that only sorts last is not a veto: the queue drains, and last arrives.

## The work queues

`listTrackWork` (`apps/web/src/lib/server/track-work.ts`) serves all three stages off `tracks`, outer-joined to the certification. One op, one CLI command:

```bash
fluncle admin tracks work --kind embed                      # both halves, in drain order
fluncle admin tracks work --kind analyze --scope catalogue  # the uncertified half only
fluncle admin tracks work --kind capture --json             # whose audio to buy next
fluncle admin tracks work --kind embed --count              # …and how big the backlog actually is
```

A read is a **page**, capped at 200 rows, so its length answers "how many did I get" and never "how much is left" — at catalogue scale those differ by orders of magnitude. `--count` adds `queued`: the whole backlog for that kind and scope. It is opt-in because the 5-minute box sweeps do not need it and should not pay for it; the `embed` predicate is backed by a **partial index** (`tracks_embed_queue_idx`, over exactly the un-embedded rows), which both makes that count cheap and keeps the embed queue read off a full scan of a table whose rows each carry a ~20 KB vector.

| kind      | the worklist                                                                                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture` | no audio yet, and the capture state machine still says it is worth trying (`pending`/NULL; a `failed` row only past its cooldown and under the failure cap). A **finding** also needs a coordinate — the R2 key is `<logId>/…`. A **catalogue** row also needs a ranked, non-vetoed tier. |
| `analyze` | audio on file, and the stored analysis did not come from it (`analyzed_from <> 'full'`). **Data**-derived, not status-derived — a catalogue row has no `enrichment_status` to drive a queue with.                                                                                         |
| `embed`   | audio on file, no vector. The captured full song is the only admissible source; a preview vector is garbage (ratified).                                                                                                                                                                   |

### The order is the budget

Audio capture is metered — a residential proxy bills **per GB** — so the order this queue drains in literally decides what the money buys. It is one `ORDER BY`, evaluated in SQL:

1. **Certified first.** A finding is a track Fluncle already said yes to. Its backlog outranks any speculative catalogue row, always — the catalogue can never starve the archive. (Proven: a catalogue row on the _top_ rung still loses to a finding.)
2. **Then `capture_priority` DESC** — the Ear's pre-audio ladder (artist > label > seed-label > nothing). Every finding coalesces to 0 here, so the rung only ever orders the catalogue.
3. **Then newest-first** within the findings, then the track id, so a tick is deterministic.

Never insertion order. Never alphabetical.

### The veto is a predicate, not a sort

A label the operator ruled out is now **tier −1** — its own tier, strictly below `none`'s 0. That is what makes it enforceable: the capture worklist excludes it in SQL (`capture_priority >= 0`), so a vetoed track is **never handed to the thing that spends money**. Every display property [docs/the-ear.md](./the-ear.md) promises survives: the row keeps its place in the capture lens, still sorts last, still carries its honest reason line. Ordered last, kept anyway — and never bought.

It is scoped to **capture alone**, deliberately. A ruling governs what Fluncle _acquires_ ([docs/label-entity.md](./label-entity.md) — a capture **is** an acquisition), not what he may measure. If the bytes are already on file, analysing and embedding them is free, and the resulting vector is how The Ear gets to _disagree_ with the ladder.

### …and the order is not the whole budget

The order decides **what** the metered GB buy. It says nothing about **how much** — and a queue drains whatever it is given, so at catalogue scale that gap is ~1,150 songs (~9 GB) a day, forever. The **capture budget** ([docs/the-ear.md](./the-ear.md) § The capture budget) is the how-much: a default-deny kill switch plus a rolling-24h count/byte cap on the `settings` KV, consulted by `listTrackWork` **before** the `capture` worklist is selected.

It is applied here, at the queue, because this function is the only door a catalogue row can reach a metered download through — so every client obeys it. When the budget is shut the capture worklist **narrows to the findings**, never to nothing: the archive is not starved by the telescope. And like the veto, it gates **capture alone** — bytes already bought are free to analyse and embed.

## The certification rail

One rule, and it is canon: **Fluncle does not speak about a track he has not been to.**

The danger is that `update_track` is a single generic endpoint. The analysis fields (`bpm`, `key`, `features`, `embedding`, the capture side-channel) and the fields that make Fluncle _speak_ (`note`, `contextNote`, the observation, the video, `galaxyId`, `enrichmentStatus`, `logId`) go through the very same call. So `updateTrack` gates on certification:

- an **uncertified** track takes every analysis field, and
- **refuses every certification field** with a `409 uncertified` that names the field.

It refuses **loudly** on purpose. `update findings … where track_id = ?` on a row with no finding matches zero rows — it _succeeds_, silently, reporting the fields as written. That is the worst failure available, which is why the rail is a thrown error and not a hopeful `WHERE` clause. The path also never `INSERT`s a `findings` row: certifying a track is `publish_track`'s job alone.

The publish and video ops need no new gate — they resolve through `requireTrack` → the finding join, so a catalogue track is a 404 there and they cannot so much as name it. The read join and the write rail enforce the same rule from two directions.

Both halves are proven against the real schema in `findings-certification.integration.test.ts`: a catalogue track **can** be analysed, embedded, and given captured audio; it **cannot** get a note, an observation, a video, a publish, a galaxy, a context note, an enrichment status, or a coordinate. A mixed payload (a legal measurement plus an illegal claim) is rejected **whole** — a partial success is how a catalogue track would quietly acquire half a finding.

## The GPU batch

The on-box sweep (`fluncle-embed`, rave-02) embeds **one track per 5-minute tick**, and rave-02 is CPU-only: a windowed full-song MuQ forward is minutes-scale there, so the box does roughly a dozen tracks a day. That is fine for the certified archive — Fluncle finds ~15 tracks a _week_ — and hopeless for the catalogue, which arrives in the thousands. At a dozen a day a 10k catalogue is two years, and a catalogue track with no vector is a track The Ear cannot hear at all.

`embed-batch.ts` is the same job in the other shape: take tracks off the **same** queue, pull their audio, embed them on the GPU, write the vectors back through the **same** agent-tier API.

### The run is bounded by the CLOCK, not by the queue

This is the design, and everything else follows from it. **You do not rent 200 tracks. You rent an hour.** A batch that embeds one page and exits leaves the pod idle for the rest of the hour you have already paid for — the entire cost with almost none of the benefit. So the run takes a **time budget** and keeps pulling pages until the queue is dry or the budget is spent.

- **`--minutes N`** (env `FLUNCLE_EMBED_RUN_MINUTES`, default **55**) is the run. It is the number to reach for.
- **`--limit N`** is the **page** — how many tracks ride one `embed-track.py` call. It is not the run size, and it is capped at **100** (see the prefetch below). The default is the cap.

**Pick `--minutes` by the block you rented, minus a margin.** Spilling one minute past an hour boundary buys a whole second hour for one track, so the run always stops **short** on purpose:

| you rented | pass                         |
| ---------- | ---------------------------- |
| 1 hour     | `--minutes 55` (the default) |
| 2 hours    | `--minutes 115`              |
| 4 hours    | `--minutes 235`              |

Four properties make the hour actually fill, and each is proven with a fake clock and a stubbed GPU in `embed-batch.test.ts`:

**The page is sized to the time that is left.** Each page is cut to `remaining time ÷ observed per-track time` — measured from the pages this run has already done, never a hardcoded guess. A page of audio pulled out of R2 and then abandoned is money paid for nothing, so a page the budget cannot finish is never started.

**The first page is ONE track — a calibration probe.** A run cannot stop in the middle of a page: whatever a page starts, it finishes. So sizing the first page off a _guess_ is the one mistake here that can cost real money — guess 60s/track on a pod that turns out to do 6 minutes, and a 10-track first page overruns a 20-minute budget by an hour. Instead the run embeds a single track, measures what it actually cost (model load included), and sizes every page after it against that number. The probe cannot overrun by more than one track, and it adapts to the pod it is actually on: a fast GPU opens the pages straight up to the cap; a slow one keeps them small.

**The next page's audio downloads while the current page is on the GPU.** The pod is remote from R2 and the GPU is the expensive thing in the room, so the R2 pull is overlapped with the inference (`DOWNLOAD_CONCURRENCY` is the parallelism _within_ a page; this is the one _across_ pages, and it is where the throughput is). This is why the page cap is 100 and not the server's 200: the page currently on the GPU has not had its vectors written back yet, so the server still lists those tracks at the head of the queue — the prefetch has to read _past_ them, and a 200-row read cannot see past a 200-row page.

**It is resumable, and it reports honestly.** An embedded track leaves the `embedding_json IS NULL` queue and the write-back is per _track_, so a pod reclaimed at track 400 of 500 has 400 vectors safely in the archive and the next run picks up at 401 — nothing is checkpointed because nothing needs to be. And the summary carries **`remaining`**: the size of the whole backlog, **counted server-side** after the write-backs. A run that says "done" while 8,000 tracks are still queued is lying to the person deciding whether to rent another hour.

**It is one inference script, not two.** `embed-track.py` runs both paths, switched by two env knobs:

| knob               | box (CPU)    | pod (GPU)             |
| ------------------ | ------------ | --------------------- |
| `MUQ_DEVICE`       | `auto` → cpu | `cuda`                |
| `MUQ_WINDOW_BATCH` | `1`          | `8`–`16` (VRAM-bound) |

That is the load-bearing decision here. The decode → window → mean-pool → L2-normalize pipeline **is** the embedding contract; a second implementation of it "for the GPU" is exactly how you end up with two vectors of the same track that no longer sit in the same space. Same script, same windows, same pooling — only the device and the number of kernel launches differ. The windows of a song are independent (each is mean-pooled over its own time axis _before_ the cross-window mean), so stacking them into one `[B, samples]` forward changes nothing about the arithmetic. A short final window is zero-padded to stack, and its mean is taken over its own true frame count, so the padding is never averaged in and a batched run agrees with a sequential one.

**The boundary.** This is the _consumer_ side: given audio already in private R2, embed it. How the bytes got there is a separate concern with its own metered budget and is not this script's business.

### The runbook (operator-fired)

The pod costs money by the minute, and **nothing in this repo can start one** — that is deliberate. The operator rents it, runs the batch, and destroys it.

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

Read the last three fields and nothing else:

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
