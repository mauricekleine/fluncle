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
```

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

`embed-batch.ts` is the same job in the other shape: take N tracks off the **same** queue, pull their audio, embed them in **one GPU pass**, write the vectors back through the **same** agent-tier API.

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

**1 · Size the job before renting anything.** From any machine with the CLI:

```bash
fluncle admin tracks work --kind embed --limit 200 --json | jq '.tracks | length'
```

**2 · Rent the pod.** A single mid-range CUDA GPU is plenty — MuQ-large is a ~300M-parameter encoder and a ~30s window at 24 kHz is a small tensor; the batch is bound by VRAM and by the R2 download, not by FLOPs. Start from RunPod's **PyTorch** template (CUDA + torch preinstalled) and give it enough disk for the batch's audio (a 200-track batch of full songs is a few GB).

**3 · Bootstrap the pod.** `embed-batch.sh` (beside the orchestrator) does the whole thing — installs bun, ffmpeg and `muq`, clones the repo, and runs the batch:

```bash
curl -fsSL https://raw.githubusercontent.com/mauricekleine/fluncle/main/docs/agents/hermes/scripts/embed-batch.sh | bash -s -- --limit 200
```

Or, if you prefer to see each step, run them by hand — the script is short and is the source of truth for what they are.

**4 · Dry-run first.** It answers "what would this batch do" **without** starting the GPU and without pulling a single billed byte out of R2:

```bash
bun docs/agents/hermes/scripts/embed-batch.ts --limit 200 --dry-run
```

**5 · Run it.** Then again. And again — the batch is **resumable by construction**: an embedded track leaves the `embedding_json IS NULL` queue, so re-running after a crash (or a reclaimed spot pod) simply picks up what is left. Nothing is checkpointed because nothing needs to be.

```bash
MUQ_DEVICE=cuda MUQ_WINDOW_BATCH=8 bun docs/agents/hermes/scripts/embed-batch.ts --limit 200
# {"ok":true,"catalogue":193,"done":198,"downloaded":200,"failed":2,"findings":7,"queued":200,"scope":"all","writeFailed":0}
```

**6 · Re-rank, so The Ear can hear them.** New vectors move the corpus fingerprint, so the ranking sweep self-heals — but drive it now rather than waiting:

```bash
fluncle admin catalogue rank --limit 250 --json   # repeat while `remaining > 0`
```

**7 · Destroy the pod.** It bills while it exists, not while it works.

**Tuning.** Raise `MUQ_WINDOW_BATCH` until VRAM complains, then step back one. Raise `FLUNCLE_EMBED_DOWNLOAD_CONCURRENCY` (default 6) if the GPU is idling between tracks — the pod is remote from R2 and the download is latency-bound, so this is usually the first thing to move.

**Safety.** The pod holds an **agent**-scoped token and speaks only to the Worker; it never touches the database. It sends `{ embedding }` and nothing else — no status, no note, no coordinate — and the certification rail would 409 it if it tried. The downloaded songs are private audio and are deleted from the pod's disk on every exit path.

## Files

- `apps/web/src/lib/server/track-work.ts` — the three queues, the drain order, the veto predicate.
- `apps/web/src/lib/server/track-work.integration.test.ts` — the order + veto proofs, on a real engine.
- `apps/web/src/lib/server/track-update.ts` — the certification rail (`CERTIFICATION_FIELDS`).
- `apps/web/src/lib/server/findings-certification.integration.test.ts` — the rail proofs.
- `docs/agents/hermes/scripts/embed-batch.ts` + `embed-batch.sh` — the GPU batch and its pod bootstrap.
- `docs/agents/hermes/scripts/embed-track.py` — the one inference script, CPU and GPU.
- `docs/agents/hermes/scripts/embed-sweep.ts` / `enrich-sweep.ts` — the on-box sweeps, now catalogue-aware.
