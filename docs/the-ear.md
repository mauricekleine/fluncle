# The Ear — the ranked catalogue

The catalogue is every track the archive knows and Fluncle never certified: a row in `tracks` with **no row in `findings`**. The Ear is what makes that pile useful — `/admin/catalogue`, ranked by one question: _how close does this sit to something he already loves?_

**It is a telescope, not a conveyor belt.** The operator finds ~15 bangers a week, so volume is not his constraint. But that pace is necessarily shallow and recency-biased — he sees whatever the feeds put in front of him, while whole regions of the genre (older releases, small labels, the long tail) never cross his path. The Ear points at the tracks sitting near what he already loves and never reached him. It is a short, high-conviction list he _wants_ to open, and if it ever feels like a backlog to grind, it has failed — the fix then is fewer rows, never more.

Nothing here is a finding, and nothing here can become one by accident: a catalogue row has no Log ID, no note, no video, no galaxy, because those columns live on `findings` and this row has none. The tier has **no public name** — `catalogue` is the internal word (code, docs, `/admin`) and never surfaces in public copy.

## The ranking: max-similarity to ANY finding

A candidate's score is the cosine similarity to its **single nearest finding**. Not to a centroid, and this is the decision the whole feature turns on: the operator's taste is multi-modal — the k=4 galaxy fit found four regions he could name by ear — and the mean of four regions is a place none of his taste actually lives. A liquid roller has to be allowed to win on the liquid findings alone, without being dragged down by the neuro ones.

The proof is executable: `catalogue.integration.test.ts` seeds a corpus of eight findings crowded on one axis and one lonely finding on another, then asserts that a dead ringer for the **lonely** finding outranks a mediocre match for the crowd. Under a centroid ranking that assertion inverts.

**And every row carries its WHY.** The score is the claim; the finding it matched is the evidence. A row reads _"Closest to 012.2.4L · Krakota — See For Miles"_, never a bare `0.91`. An instrument the operator cannot interrogate is one he stops looking through.

## The architecture: precompute, then read

Ranking the catalogue against the findings at request time is a **cross join**: at 10k catalogue rows × 60 findings that is 600,000 cosine operations over 1024-dimension vectors, per page load. It does not get slow — it dies.

So the arithmetic happens **once, ahead of time**, in a periodic sweep, exactly like the cluster engine's nightly assignment tick ([docs/agents/cluster-engine.md](./agents/cluster-engine.md)). The sweep stores each catalogue track's answer on the row; the page then does an ordered walk of an indexed column. **There is no vector math on the request path at all.**

Six columns on `tracks`, written **only** by the sweep and meaningful **only** on a catalogue row (the sweep anti-joins `findings` and never touches one, so a non-null `nearest_finding_score` is itself a catalogue marker):

| column                     | what it holds                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `nearest_finding_score`    | cosine similarity to the nearest finding (`1 − vector_distance_cos`, so higher is nearer). The Ear's sort key.        |
| `nearest_finding_track_id` | **which** finding. The row's WHY.                                                                                     |
| `capture_priority`         | −2…3, the pre-audio ladder (−1 a ruled-out label, −2 a duplicate). The capture queue's sort key.                      |
| `duplicate_of_track_id`    | the finding OR canonical catalogue sibling this row is the SAME RECORDING as. The duplicate's WHY — see _Duplicates_. |
| `catalogue_rank_corpus`    | the corpus fingerprint the values above were computed against, `"<logic-version>:<findings>:<embedded>"`. Staleness.  |
| `catalogue_ranked_at`      | when. Freshness for the operator; never a predicate.                                                                  |

Two indexes (`tracks_nearest_finding_score_idx`, `tracks_capture_priority_idx`) serve the two ordered reads. NULLs sort first in an ASC index, so a DESC walk hits the ranked rows first and stops at the page's `LIMIT` — the cost is the page, not the corpus.

### The three database rules, all load-bearing

Per [docs/local-database.md](./local-database.md):

1. **Rank in SQL.** `vector_distance_cos(candidate.vec, finding.vec)` runs in the database and only the winners come back — two scalars per candidate. Pulling vectors into the isolate to rank them is what OOMs the 128 MB Worker.
2. **Both sides of the distance are stored BLOB columns**, never a bound text vector. (The 14× text-probe cliff is about _binding_ a probe; there is no probe here — this is a column-to-column join, which never re-parses anything.)
3. **No ANN index.** `libsql_vector_idx` wedged hosted Turso's write path for 20+ minutes in the spike. The exact scan is the ratified shape, and here it is bounded to `batch × findings` — which is what the batching is for.

### Self-healing, by fingerprint

Staleness has two halves. The **corpus half** is a fingerprint of the finding corpus, `"<findings>:<embedded findings>"`, stored on every ranked row. Both numbers move whenever the corpus side of the answer could change: log a finding and the first moves (a new artist/label affinity, a new candidate to be near); embed one and the second moves. A row whose stored fingerprint differs from the live one is stale and re-ranks on a later tick.

The **row half**: a catalogue track that gains its _own_ vector (captured → embedded) moves neither number, so the fingerprint alone would leave it ranked on the pre-audio ladder forever — the first 58 catalogue embeds hit exactly this. The discriminator is `capture_priority`: the vectored scoring path always nulls it and only the pre-audio ladder sets it, so _has-a-vector AND still-carries-a-tier_ reads precisely as "ranked before its vector arrived" and joins the stale predicate. One tick re-scores it, the write clears the tier, and it leaves the set — no loop, even for a malformed vector (that stamp clears the tier too).

So the sweep **converges on its own after any archive change** — corpus or row — and needs no invalidation call from the publish or capture paths. The fingerprint is compared with `<>`, never `<`, so a _deleted_ finding is caught exactly like an added one. On an unchanged archive the tick is a no-op.

### The cost model

|                                   |                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per tick                          | `candidates-with-a-vector × embedded findings` distance computations, all inside the database. At the default batch of 250 and 60 findings: **15,000**.                      |
| A full re-rank of a 10k catalogue | 40 ticks, **600k** computations — done once, off the request path, instead of once per page load.                                                                            |
| Per page load                     | **zero.** An indexed walk of 50 rows, plus one batched hydrate of the matched findings.                                                                                      |
| Wire                              | The sweep's candidate read returns `(track_id, artists_json, label, has_vector)`; the ranking returns `(candidate, finding, distance)`. **No vector ever crosses the wire.** |

## The capture queue — and the chicken-and-egg it exists to solve

A catalogue track has **no vector until its audio has been captured**, and capture is metered (a residential proxy bills per GB) — so we will not capture everything. Which means the Ear's score cannot be what prioritises capture: the tracks that most need capturing are precisely the ones with no score yet.

`capture_priority` is the pre-audio answer — the cheap metadata signals that _can_ be read before a single byte is downloaded, ordered as a small, explainable ladder rather than a model, because the operator has to be able to see why a track is next:

| tier | rung            | the claim                                                                                                                                        |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✗    | `skipped-label` | **the veto, checked first.** Its label is one the operator ruled out. Tier **−1**, whatever else is true of the track.                           |
| 3    | `artist`        | an artist on it is **already on a finding**. His ear has said yes to this artist — the strongest signal there is.                                |
| 2    | `label`         | its label already carries a finding. A DnB label is a curator; a label he has found on is a crate he digs in.                                    |
| 1    | `seed-label`    | its label is one he rules the crawler may seed from ([docs/label-entity.md](./label-entity.md)), nothing certified on it yet. In-lane, unproven. |
| 0    | `none`          | nothing ties it to the archive.                                                                                                                  |

**The veto is not decoration, and it was caught on real data.** Every one of the operator's 8 **disabled** labels — Anjunabeats, Armada, Axtone, Positiva … — _carries a finding_: each arrived on a single crossover remix. So without the veto, the `label` rung fires on all of them, and the capture queue spends a metered, per-GB audio budget buying trance and house records he has explicitly said are not his lane.

And it does **not** breach the crawl-scope-never-storage rule. A ruling governs what Fluncle _acquires_ next, and a capture **is** an acquisition — the same class of act as a crawl, just further down the same pipe. Nothing stored moves: the track keeps its row, keeps appearing in the capture lens, and keeps an honest reason line ("not your lane. Ranked last, kept anyway."). It is ordered last, never deleted, hidden, or changed. This is the one sanctioned way `seed_state` reaches the ranking, and it decides an ORDER, never a visibility.

`capturePriorityFor` is **pure**, and it is the ladder's single authority: the sweep calls it to _write_ the tier, and the surface calls it to _explain_ the tier. They cannot drift, because they are the same function. Label matching goes through `labelSlug` — the same fold that makes `Pilot.` and `Pilot` one label everywhere else.

The two lenses are **disjoint by construction**: scoring a track clears its `capture_priority` (it has audio, so capturing it again is the one thing the queue must never ask for), and the capture lens is exactly "catalogue, no score yet".

**The veto has its own tier, and that is what makes it enforceable.** It first shipped sharing `none`'s 0, which left it invisible to SQL — the capture _work queue_ could not tell "capture this last" from "never spend a metered per-GB byte on this", so the veto could only ever be a sort. And a sort is not a veto: the queue drains, and last arrives. At **−1** it is a predicate (`capture_priority >= 0`), and every display property above survives untouched — the row keeps its place in the capture lens, still sorts last, still carries its honest reason line. Ordered last, kept anyway, and never bought.

`capture_priority` is what the **work queues** ([docs/gpu-batch-embed.md](./gpu-batch-embed.md)) actually drain on: `list_track_work` serves capture, analysis, and embedding off `tracks`, ordered certified-first and then by this ladder. The veto is scoped to **capture** alone — a ruling governs what Fluncle _acquires_, not what he may _measure_, so a vetoed track whose bytes are already on file is still analysed and embedded (and its vector is how The Ear gets to disagree with the ladder).

This repo does **not** build the capture itself — the acquisition layer lives in the private companion repo (the-archive RFC, D6). The Ear ships the queue and the priority signal; the layer that acts on them reads `capture_priority` and works down.

## The long-form veto — a mix is not a track

A recording at or above **`LONG_FORM_MS` (15 minutes)** is a continuous DJ mix riding a MusicBrainz compilation release ("Drum&BassArena Summer Selection 2012 (Continuous mix 1)", 78 minutes), not a track (operator ruling, 2026-07-13). The crawler mints them honestly — they ARE recordings on releases it walks — but they are unloggable as findings and pathological on the ear lens: an hour-long mean-pooled MuQ vector is a taste-centroid of everything inside it, so a mix ranks artificially high against ANY finding (the two captured ones scored 0.92/0.91) while never being a discovery. They are also the fattest thing the metered capture can buy (74.5 MB for one). So a long-form row is excluded by duration alone — deterministic, no title heuristics — from **both lenses and their headline counts** (`listCatalogueTracks` / `getCatalogueSummary`) and from the **capture worklist's catalogue half** (`track-work.ts` — a finding is never duration-gated), refusing the ~81 uncaptured mixes ≈ 4–5 GB of proxy spend that sat in the queue when the veto landed. The veto is a READ + QUEUE exclusion, never a deletion: a captured mix keeps its bytes and vector (already paid for, and harmless — a catalogue row is never anyone's nearest-finding candidate).

## Duplicates — already in the archive

The crawler walks outward from labels, not from the archive's own tracks, so it will re-surface a recording Fluncle **already logged** — a release re-issued on a compilation, the same master under a second catalogue number. That row is worthless to buy: capturing it spends metered proxy bytes on audio already on file. It was caught on real data — a crawled "Infinity" scored a perfect **1.0** against a finding, and pre-audio it sat on the capture ladder where the budget would have bought it.

So the sweep flags a duplicate, and it never gets bought. There are **two detectors, one for each side of the audio boundary**, because the identity signal changes the moment a row has a vector:

1. **Pre-audio — the money saver, an ISRC match.** In the pre-audio ladder half, a catalogue row whose `isrc` (non-null, non-empty) equals a certified finding's `isrc` is the **same recording**. The sweep writes it the dedicated tier **−2** (strictly below the label veto's −1) and stores the finding on `duplicate_of_track_id`. The veto is enforced by the **existing** `capture_priority >= 0` predicate the capture queue already applies ([docs/gpu-batch-embed.md](./gpu-batch-embed.md)) — a duplicate is a reused veto, not a second mechanism, so `track-work.ts` is untouched. ISRCs are folded (case + stray hyphens stripped) before comparison, the same spirit as `labelSlug`. The finding corpus this reads is bounded by the finding count, exactly like the affinity sets.

2. **Post-embed — the honesty marker, a near-identical score.** Once a row has a vector it is off the capture queue, so the ISRC veto no longer applies — but a duplicate now shows up as the thing it always was: a cosine of **≥ 0.995** to its nearest finding (an identical master lands at ~1.0; a remaster, edit, or VIP arranges differently enough to fall below). This half is **display-only** — nothing is stored, no state machine — and the threshold (`DUPLICATE_SIMILARITY`) is a named, tunable constant. Since the 2026-07-15 ruling (the Anwius "Trust" case) a row in this band **never occupies a ranked ear slot**: a known copy is not a discovery, and its near-perfect score would sit above every real one. The marker stays display-only; only the ranking excludes it.

3. **Catalogue-internal — the same master under a second MBID.** The two detectors above compare a catalogue row against the **findings**; they are blind to the commonest duplicate at scale, which is a catalogue row against **another catalogue row**. The crawler walks MusicBrainz, which carries a distinct recording MBID per release/compilation, so one song enters `tracks` as several rows and each is captured + embedded separately — the same master bought two or three times, only one sibling ever carrying an ISRC (the 2026-07-13 audit measured ~46 such redundant captures, bit-identical at cosine distance ~0). The sweep reads the identity of every **captured** catalogue row (`readCatalogueIdentity`, bounded by the captured half — the metered ≤1,000/day table, never the raw metadata catalogue, and it pulls no vectors), names one **canonical** sibling (the most-processed: a row with a vector, then the smallest `track_id`, so the choice is stable and idempotent), and marks the rest `duplicate_of_track_id` + tier **−2** — the same reused veto. The identity is the folded title+artist `matchKey` (so a remix's own descriptor never merges into the base), with an exact ISRC match as the fallback for a row whose title drifted between MBIDs. It fires on **both** sides of the audio boundary: an **uncaptured** sibling of a captured row is vetoed off the capture queue before a byte is bought (the real spend saver), and an **already-captured** sibling is re-pointed at the canonical so the ear lens stays one-row-per-recording (it keeps its vector, still reading "already in the archive"). Written inside the scoring path, not a separate pass — the normal scored write clears `duplicate_of_track_id`, so a mark made elsewhere would be wiped on the next tick.

All three surface the **same honest register**: the row stays visible (ordered last on the capture lens, still shown on the ear lens), it **names the row it duplicates**, and it is never silently hidden — the-ear.md's display promise holds for a duplicate exactly as for a vetoed label.

**It stays self-healing.** The pre-audio marker rides the same fingerprint staleness as everything else: `duplicate_of_track_id` is re-written every time a row is re-ranked, so it clears on its own when the finding it matched is deleted (the corpus fingerprint moves, the row goes stale, the next tick re-ranks it and finds no match). A stamped duplicate is not re-picked — no loop — and the scoring path nulls the marker along with `capture_priority`, keeping the two lenses disjoint.

**The escape hatch — `force_capture`.** All three detectors can be WRONG in rare cases: a shared or mis-assigned ISRC, a `matchKey` collision on a genuinely different recording. And the veto is **self-sealing** — an uncaptured row marked a duplicate is excluded from capture forever, so the post-audio similarity check that would _exonerate_ it never runs (it never gets audio to embed). `force_capture` (**operator tier**, the `clear_wrong_audio` sibling for the other self-sealing verdict) is the only exit. It stamps a **sticky `capture_status = 'duplicate-cleared'` sentinel** that all three detectors respect before re-stamping — so the self-healing re-rank never re-marks the row — and in the same write it lifts the veto (`duplicate_of_track_id` null, tier cleared) and nulls the corpus fingerprint so the next tick re-ranks the row onto the pre-audio ladder at its **honest tier**; the next open-budget capture tick then buys it (the capture work queue treats an uncaptured `duplicate-cleared` row as capture-eligible). It **bypasses the DUPLICATE veto, never the VERIFICATION gate**: a re-captured forced row still runs the ingest fingerprint gate, and a wrong-audio (cross-title near-1.0) capture still quarantines. Getting the row captured is the point — its OWN vector is what lets the finding-side detectors settle it honestly. **And the sentinel survives the capture it enables**: the generic update path's ruling guard (track-update.ts) never lets the capture sweep's terminal PATCH (`done`/`failed`/`unmatched`) overwrite `duplicate-cleared` — an operator ruling is never clobbered by a machine write, the auto-note's fill-empty-only class — so the post-embed re-rank still honours the ruling, and the capture queue schedules a forced row off the audio key + attempt stamps instead of the status (a captured forced row never re-enters the queue; a failed one backs off like any failed row). It surfaces as a quiet **"Capture anyway"** control beside the "already in the archive" marker on the capture lens.

## Wrong audio — the capture that lied

The Duplicates section above handles a row that is honestly the same recording as a finding. This section handles the row that only _looks_ like one because the wrong bytes got captured — a distinct failure, caught on real data (the 2026-07-12 capture audit).

**The defect.** A catalogue track poorly represented on YouTube gets the WRONG audio: the search returns the same artist's popular, already-logged hit; the duration guard passes on a length coincidence; and the embed then produces a vector at cosine ≥ 0.9996 to an existing finding. The row is not a duplicate of that finding — it is a _different_ track carrying that finding's audio. Left alone it does the worst thing a discovery surface can do: it floats to the very **top** of the ear lens as a fake perfect find (Flowidus "Find Your Love" ranked 1.0000000 against the finding "Shelter" — because it _was_ Shelter's audio).

**The line that separates it from an honest duplicate is the TITLE.** MuQ cosine at six-plus nines is the same master, so a near-1.0 score means one of exactly two things, and the folded title+artist `matchKey` (the same matcher the Rekordbox sync uses) tells them apart against the finding it scored against:

- **Same title → a true duplicate.** The crawler re-found a logged track, with the _right_ audio. It routes to the Duplicates handling above — `duplicate_of_track_id` + tier −2, keeping its vector and its "already in the archive" line. Never re-captured (the audio is correct), never a discovery.
- **Different title → wrong audio.** The capture grabbed the artist's other track. It is **quarantined**.

**The threshold is its own constant.** `WRONG_AUDIO_QUARANTINE` (0.9995) is deliberately distinct from `DUPLICATE_SIMILARITY` (0.995): the band `[0.995, 0.9995)` is where an alternate master (a remaster, a radio edit) honestly lands and is _labelled_ a duplicate, display-only; the cliff at 0.9995 is where "similar" is no longer possible and the row is _adjudicated_.

**Quarantine rewinds the row to before its audio arrived.** In one write the sweep drops the poisoned vector (a catalogue row is never anyone's nearest-finding candidate, so nulling it poisons no other ranking), nulls the score so it leaves the ear lens, re-derives the pre-audio ladder tier so it re-enters the capture queue for a fresh download, and stamps `capture_status = 'wrong-audio'`. The collided finding stays on `nearest_finding_track_id` as the WHY the quarantine lens reads. The one thing it **keeps** is `source_audio_key` — the bad bytes' sha256 is embedded in it, and that is the memory that stops the re-capture from re-downloading the identical mistaken master (no new vendor data, and a stronger check than a stored video id). The capture sweep rejects any candidate whose bytes hash to it and walks to the next; if the only matches are the bad master, it lands `unmatched` rather than looping.

**The state machine, all on `capture_status` (no migration — it is a text column):**

| state                | what it means                                                        | queues                                                                                                           |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `wrong-audio`        | quarantined, awaiting a fresh capture                                | a re-capture TRIGGER in the capture queue; EXCLUDED from embed + analyze (the key still points at the bad bytes) |
| `quarantine-cleared` | the operator's `clear_wrong_audio` override — "this capture is fine" | terminal for capture; embed re-embeds its kept audio so it re-ranks                                              |

**Convergence is preserved, and it needed one refinement.** The row-half staleness discriminator gained a `capture_priority >= 0` clause: a vectored row carrying a NON-negative tier is "ranked before its vector arrived" and re-ranks, but a _negative_ tier (the −2 true duplicate) is a deliberate decision the scoring path made, so it is left stable — no re-pick loop. A quarantined row has no vector, so it is stable the moment it is stamped. A `quarantine-cleared` row is never re-quarantined even at a near-1.0 score, so the operator's override wins exactly like his note wins over the auto-note.

**The operator sees all of it — and his ears hold the verdict.** Quarantined rows get their **own quiet lens** on `/admin/catalogue` (`?lens=quarantine`), shown only when there is something in it, each naming the finding its audio came back as. On this lens the artwork audition plays the **captured bytes themselves** (through the operator-tier `get_source_audio` proxy), not the official preview — the preview is ISRC-resolved and always the right song, so it cannot answer the one question the lens asks. Six-nines cosine proves _same recording_, never _which title is lying_, so the row carries the verdict pair:

- **Keep it** — the rare true-twin override (`clear_wrong_audio`, operator tier): "this capture is fine"; the row keeps its audio, re-embeds, and re-ranks. Doing nothing is the default verdict — a quarantined row is already queued for a fresh download.
- **Re-capture the finding** — the operator heard the row's OWN song in the captured bytes, so the poisoned capture is the **finding's** (the case the sweep can never accuse: it only ever suspects the catalogue side). One decision settles the pair: `flag_wrong_audio` (operator tier) rewinds the finding — vector dropped out of the ranking corpus (the fingerprint moves, so every fake ~1.0 it manufactured un-scores on the next ticks), `analyzed_from` nulled so the post-re-capture sweep re-enriches the bpm/key it measured off the wrong song, re-capture queued with the bad bytes hash-rejected — and the catalogue row is kept in the same stroke.

A bad capture never silently vanishes, on either side of the collision.

### The verification gate — verify at ingest, so the lie never lands

Everything above catches a wrong capture **after** it has poisoned a vector — a detector. The gate is the **preventer**, and it came out of a second real defect (finding **005.9.9L**, the 2026-07-12 audit): the sweep's yt-dlp search picked a same-label upload whose audio was a different song, and the old TRUSTED-CHANNEL relaxation waived the duration guard (expected 198.6s, stored 246.9s off an Elevate Records channel video). Wrong bytes are **inaudible on every human surface** — the site, the video, and the radio all play the ISRC-resolved official preview, never the captured file — so they only poison analysis, BPM/key, and the MuQ ranking space, silently. The ruling: **verify every download against the official preview at ingest.** The preview is ISRC-resolved, so it is the right recording _by construction_ — the one reference that can answer "are these the same recording?".

**The mechanism is Chromaprint.** After a candidate downloads, the sweep fetches the track's preview through the same `/api/preview` relay the site uses, fingerprints both files with `fpcalc -raw -json`, and runs a **sliding-window bit-error match**: does the preview's fingerprint appear as a contiguous window anywhere inside the capture's, within `DEFAULT_MAX_BER` (0.20 — AcoustID practice is <0.15 for same-source audio; widened for our cross-source Deezer-preview-vs-YouTube-capture pair, still far below the ~0.45+ different-recording regime; env-overridable via `FLUNCLE_VERIFY_MAX_BER`)? The matcher lives in one shared module (`fingerprint-match.ts`) so the ingest gate and the backfill below cannot drift. The preview is a verification **reference only** — it never feeds a vector and is never stored as analysis input (full-audio-only is ratified).

**The three verdicts, and the honesty rule.** A MATCH stores as before, stamped `capture_verification = 'preview-match'`. A MISMATCH **rejects the candidate before storing** — nothing to quarantine because the bad bytes never land — remembers it (below), and walks to the next ranked candidate; all candidates exhausted lands the honest `unmatched`. NO PREVIEW SOURCE (or no fpcalc on the box yet) and the gate **abstains**: capture proceeds, stamped `'unverified'` — never a silent pass, never a block on a track with no reference. `null` means pre-gate legacy.

**Channel trust is demoted.** The trusted-channel path still helps RANK candidates (a label upload beats a random re-host of the same-length master), but it no longer widens the duration guard — the +60s trusted pad was exactly the 005.9.9L hole, and it is gone. Nothing skips the gate.

**Finding the upload, before any of that runs — the `unmatched`-rate fix (2026-07-13).** Of ~920 captures, 170 landed `unmatched`: the proxy SEARCH was billed but no acceptable audio was found. Two reach improvements attack it without touching a guard. First, the ranker now recognizes a YouTube auto-generated **`<Artist> - Topic`** channel — the art-track YouTube builds per artist from the label-delivered master, which is duration-exact and ISRC-tagged by construction. It is the safest possible candidate, but its video TITLE is the bare song, so the title-only "official" marker missed it entirely; recognizing it by CHANNEL name promotes it to the top of the ranked list (a tiebreak only — the fingerprint gate is still the identity check). Second, when the primary `<artists> <title>` search returns **zero raw candidates** — the failure mode of an over-constrained multi-artist credit ("Commix Nu:Tone Logistics Coffee") or an odd-punctuation title — the sweep spends ONE de-constrained fallback search (primary artist + a version-stripped title) before declaring `unmatched`. The fallback fires ONLY on zero raw results: when candidates came back and merely missed the duration guard, the song genuinely isn't there at that length and a reshaped query cannot conjure it, so no second search is billed. The per-finding search ceiling is `FLUNCLE_CAPTURE_QUERY_VARIANTS` (default 2); there is no loop. A track with no reference duration (`duration_ms = 0/null`, ~16% of the unmatched) is still structurally unmatchable — the guard has no reference to run against — and is left to the crawler's metadata backfill, not papered over here.

**The rejection memory** — `source_audio_rejected`, a JSON array on `tracks` of `{ videoId, sha256, reason, at }`, capped at the newest ~10. It generalizes the old single-sha memory (the digest embedded in a quarantined row's kept `source_audio_key`, which still works for pre-memory rows): the **videoId is the pre-download filter** — a known-bad candidate never costs proxy bytes again — and the **sha256 is the deep backstop** — the same audio re-uploaded under a new id is rejected post-download and remembered. Every rewind grows it: the gate's fingerprint mismatch, the rank sweep's quarantine, and the operator's `flag_wrong_audio`.

### The backfill — every historic capture gets the same check

The gate verifies what downloads **from now on**; `fluncle-verify-captures` (an on-box host timer, [docs/agents/hermes/verify-captures-timer/](./agents/hermes/verify-captures-timer/README.md)) walks every capture that landed **before** it (~590 rows, findings + catalogue). The box only **measures** — one private-R2 read of the captured bytes, one preview fetch, the same fingerprint match — and reports a plain verdict through the agent-tier `verify_capture` op; the **Worker routes it**, so the doctrine has one integration-tested authority:

- **match** → `capture_verification = 'preview-match'`; **no preview** → `'unverified'`. Either way the row leaves the `capture_verification IS NULL` worklist, which is what makes the sweep bounded, resumable, and never a re-verifier.
- **mismatch on a CATALOGUE row** → the quarantine rewind above (vector dropped, re-queued for capture, sha into the rejection memory), with the `'mismatch'` stamp kept as the quarantine lens's honest WHY — a preview mismatch reads differently from a cross-title archive collision. The machine may rewind a row Fluncle never spoke about.
- **mismatch on a FINDING** → stamped `'mismatch'` and **nothing else**: a machine does not rewind a public finding. The stamp raises a `capture-suspect` row on the `/admin` attention queue, pre-evidenced; the operator auditions the captured bytes and rules with `flag_wrong_audio` (which nulls the verdict, so a ruled row leaves the queue).

**The second reference rung — reaching the ISRC-less rows, without lowering the bar.** The rungs above resolve the reference by ISRC (a fresh Deezer, exact-Apple, the ISRC preview). ~221 historic captures have `isrc IS NULL` and no stored preview, so that resolver can never reach them and they sit `unverified` forever — even though the ground-truth sample says they are almost certainly clean. The backfill adds a second, **lower-trust** rung for exactly those rows: resolve a candidate preview by **TITLE + ARTIST** search against an allowed preview source (the keyless iTunes Search API), gated hard on **PRECISION over recall** — a wrong reference would manufacture a false mismatch and quarantine good audio, which is strictly worse than leaving a row unverified. The candidate is trusted only when it clears three guards: **folded-identity** (the hit's `matchKey` — artist set + base title + version descriptor — must EQUAL the row's, the same discipline the Rekordbox sync uses, so a remix never stands in for its original), **duration agreement** (within the capture tolerance of the row's stored length), and **unambiguity** (zero confident hits, or several that disagree on length, abstain — never a guess). And even a confident title+artist reference can only ever **confirm** a capture: a fingerprint mismatch against it is mapped to the honest abstain (`unverified`, recorded distinctly in the sweep's tally), **never** the `mismatch` verdict — so the destructive finding/catalogue split above runs only for a byte-exact ISRC reference. A low-trust reference can leave a row unverified; it can never rewind good audio.

## The capture budget — the brake

The ladder above decides **what** the metered GB buy. It has nothing to say about **how much**, and at catalogue scale that gap is the one that costs real money.

The bounds the capture sweep shipped with were tuned for **findings**: the operator logs ~15 a week, so a batch of 4 every 5 minutes describes a queue that is empty almost all the time, and the bound never binds. The crawler changes what those same numbers mean. It writes uncertified rows by the thousand, and a queue drains whatever it is given: **4 × 288 ticks ≈ 1,150 songs ≈ ~9 GB of metered proxy traffic per day, indefinitely, with nothing in the system that would ever say stop.** The operator has ruled that he does not want to capture everything, and the reason is the bill. Until the budget, nothing enforced that ruling.

So the catalogue half of the capture queue carries a **budget** and a **brake**, three rows on the shared `settings` KV — the same store the auto-advance kill switch and the clip drip's switch ride, deliberately not a third mechanism. All three are changeable **in one flip, with no deploy**, from `/admin/catalogue` or `fluncle admin capture`. A spend you can only stop by shipping a build is a spend you cannot stop.

| key                              | what it holds                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `catalogue_capture_paused`       | the **kill switch**. Default-deny: only the literal string `"false"` means running. |
| `catalogue_capture_daily_tracks` | the rolling-24h **count** cap (default **50**).                                     |
| `catalogue_capture_daily_bytes`  | the rolling-24h **byte** cap (default **1 GiB**).                                   |

### It ships OFF, and that is the whole point

The switch is **default-deny**, the exact inversion `publish-advance.ts` ships: an unset key, an empty database, a fresh deploy, a preview branch, a restored backup, a value nobody recognises — every one of them reads as **PAUSED**. The machine can spend money on a residential proxy only because an operator deliberately wrote `false` into that row, and anything that loses the row falls back to spending **nothing** rather than to spending everything. Catalogue capture is real money against a budget nobody has chosen yet, so it stays dark until he chooses one.

Findings are untouched by all of it. Every read the budget makes is scoped to the catalogue half (`tracks` with no `findings` row), so a certified finding's capture can neither consume the budget nor be stopped by it. **The archive is never starved by the telescope.**

### Why BOTH a count cap and a byte cap — and the honest limit in the byte one

Bytes are what he is billed for. Count is what the queue knows **before** it spends anything. Neither alone is enough, because of one hard ordering fact:

> **A file's size is knowable only AFTER it has been downloaded.** The queue holds metadata, not media; there is no content-length to consult at queue time. So a byte cap **cannot** be a pre-download guarantee, and anything claiming otherwise has moved the check to a place where the money is already gone.

The two caps therefore do different jobs, and the split is deliberate:

- The **count cap is the enforceable one.** It is checked before a single byte moves, and it is exact: the queue hands out N rows a day and not one more. This is the guarantee.
- The **byte cap is a backstop**, enforced _between_ batches off what already landed. It catches what the count cap structurally cannot see — a day of unusually fat files blowing through the GB the count was chosen against. It **can overshoot, and the overshoot is bounded**: at most one batch (`BATCH_CAP`, 4) × the largest file, because the gate is read once at the top of a tick and the tick then runs to the end of its batch. Tens of MB against a GB budget. That is the honest guarantee, stated rather than dressed up as a hard cap.

The count ledger counts **attempts**, not successes: a failed download still pulled bytes through the proxy, and an unmatched one still paid for a search, so a ledger that counted only successes would let a day of failures spend real money against a meter reading zero. The byte ledger sums only what **landed** — a failure's partial transfer is genuinely unknowable from the server, and is under-counted rather than guessed at.

### The brake lives at the QUEUE, not in the sweep

`listTrackWork(kind: "capture")` is the **only door** a catalogue row can reach a metered download through (`list_tracks_admin`'s queue filters drive through the finding join and are structurally blind to a catalogue row). So the budget is consulted there, in `track-work.ts`, before the worklist is even selected — which means **every client obeys it**: the box sweep, the CLI, and the next sweep nobody has written yet. A brake inside the baked box script would be re-bakeable, bypassable, and one `curl` away from irrelevant.

When the budget is shut, the capture worklist **narrows to the findings**; it never returns empty while a finding still needs its audio. And it gates **capture alone** — bytes already bought are free to analyse and embed, the same reasoning that scopes the label veto to capture ([docs/gpu-batch-embed.md](./gpu-batch-embed.md)).

The three properties are proven, not asserted, in `track-work.integration.test.ts`: the budget **stops** the sweep when spent, the kill switch stops it in **one flip** and is default-deny, and a **certified finding still captures** when the catalogue budget is gone.

### What the operator sees

The `capture` lens on `/admin/catalogue` carries the spend, next to the tracks the money would be spent **on** — a metered thing he cannot see is a thing he cannot control:

- the switch, and what it currently means;
- **bought (24h)**: N tracks of the cap, with a bar;
- **downloaded**: X.XX GB of the cap, with a bar;
- **left in the window**, or _why_ it is shut (paused by him, or the cap is spent).

```bash
fluncle admin capture budget            # what it spent, what is left
fluncle admin capture pause             # the kill switch (operator)
fluncle admin capture resume            # let it spend again, up to the budget
fluncle admin capture set --tracks 100 --gb 2
```

### Note: the sweep does not read the catalogue queue yet

The `fluncle-capture` sweep reads the catalogue-aware `list_track_work` queue (`kind=capture&scope=all`) — the one this budget gates. So catalogue capture is now **wired**, and it sits behind the brake: with the budget shut (its default-deny state) the queue narrows the sweep to the findings, so it captures certified findings exactly as it always did and cannot see a catalogue row at all. The single remaining act is the operator's — resume the budget (`fluncle admin capture resume`, or the `/admin/catalogue` control), and the catalogue half lights up on the next tick, up to the count/byte caps, with no deploy or box re-bake. Until then the wiring is inert.

## The surface

`/admin/catalogue`, one AdminShell station under Findings/Artists/Labels/Galaxies in the sidebar ([docs/admin-shell.md](./admin-shell.md)). Lenses in the subheader strip, deep-linked through `?lens=` so a pasted URL restores the view (the two below the fold — quarantine, dismissed — surface only when they hold something):

- **Closest to a finding** (`?lens=ear`, the default) — the telescope. Each row: the cover, the identity, the WHY, the score, the row actions below, and the two full-listen links. Duplicates of **either** kind never occupy a ranked slot (Maurice's rulings): the deterministic ones (`duplicate_of_track_id` set — an ISRC / same-title identity match) and the alternate-master display band alike (a scored row at ≥ `DUPLICATE_SIMILARITY`, still nothing stored — the ear filters it at read time). The page is also **diversity-decayed** (§ below).
- **Next to capture** (`?lens=capture`) — the rows with no audio at all, ranked by the ladder above, each carrying the rung that put it there.
- **Dismissed** (`?lens=dismissed`) — the restore pile (§ The operator's actions), a quiet pill shown only when there is something in it.

**No count badge on the sidebar entry.** The honest number is "how many are worth your time", and a `COUNT` cannot answer that. A telescope with a backlog badge is a conveyor belt.

**Nothing on the page is lit like a finding**: no coordinate line, no gold story-ring, no note. The rows are the same _shape_ as a finding's row and deliberately not the same _weight_ — he has not been to these ones.

The header carries **Re-rank**, one tick of the sweep by hand. The sweep is a periodic job, but the operator must be able to log a finding, poke it, and watch the ranking move — otherwise the list's freshness is something he has to take on faith.

## The diversity decay — the page spreads, the scores stay pure

Max-similarity ranking is structurally a **sonic-clone magnet**: an artist Fluncle has logged boosts _all_ their other tracks, and an undecayed page is eleven A-minor rollers from 2019. So the ranked page is re-ordered **greedily at read time** (`EAR_DIVERSITY_DECAY`, catalogue.ts): each candidate's raw score is decayed by how many rows of the same **artist** (×0.97 per prior row — the magnet, hit hardest), **release year** (×0.985), and **musical key** (×0.99 — a mixtape-building nicety: eleven A minors mix worse than a spread) already sit above it. The lens over-fetches a pool (3× the page) so a decayed clone can be displaced by a fresh artist that scored slightly lower.

Three properties are load-bearing: the **stored score is never touched** (the WHY a row displays is the true similarity — the decay re-orders, never rewrites); **labels carry no decay** (the operator's call — the label is a taste signal, not a redundancy signal); and a missing year or key simply contributes no factor. The dials are named constants, tunable like every threshold on this page.

## Fluncle's Telescope — the playlist mirror

The discovery loop, closed (operator ruling, 2026-07-15): the diversified ear top (~50 rows with a Spotify anchor) mirrors into a **private** Spotify playlist — "Fluncle's Telescope" — that the operator listens to through the day and CMD+Fs like any other discovery source. Private is load-bearing: these are **candidates, not findings**, and the public promise (Fluncle's Findings, 100% bangers) never carries a "maybe".

The playlist is **never curated by hand**. It is a pure mirror of the telescope (`telescope-playlist.ts`): the sync rides every rank-sweep tick and the operator's certify/dismiss acts, computes the desired ordered list, and — only when it differs from the last list the mirror wrote (kept on the settings KV, `telescope.last_mirror`; the playlist is never read back, so the modify scopes suffice and `playlist-read-private` is never needed) — replaces the playlist in one PUT (the order _is_ the ranking; full-replace is idempotent, nothing to reconcile). So logging a find removes it (the certification anti-join), the **thumbs-down removes it on the same act**, and a better candidate displaces a weaker one. The playlist itself can be created lazily on first sync OR hand-minted by the operator and adopted (its id lives on the settings KV, `telescope.spotify_playlist_id` — the live one was hand-created 2026-07-15 and adopted via a one-off settings write, after the API create 403'd on this app tier). The replace posts to `/playlists/{id}/items` — the legacy `/tracks` alias 403s where `/items` works. Rows without a Spotify anchor simply never reach it (the sync walks the diversified ranking to depth 200 for its 50). Best-effort by construction — a Spotify hiccup logs and returns, never failing the sweep or the operator's act.

## The operator's actions — the page is a workstation, not a readout

A ranked list he can only read is a report; the operator ruled it must be a place he can _act_. Four things live on the row, and the Unlit Rule does not reach them — this is his own tool, not a crew-facing surface (the persona law, [docs/admin-shell.md](./admin-shell.md)), so where to listen and what to do are the whole point.

- **Audition inline.** The artwork doubles as a play control: a click streams the track's official 30s preview through the shared `/api/preview` relay and the app's one preview player (the same `PreviewArtwork` pattern `/mix` uses), so starting one preview stops any other. The relay resolves a catalogue row from `tracks` (a LEFT join, not the finding INNER join the finding read uses), and resolves the clip by ISRC — a fresh Deezer, then the exact-Apple rung (#554), then fuzzy iTunes — so a catalogue row with an ISRC or a stored preview auditions; one with neither shows the plain, non-playable cover.
- **Full-listen links.** Small quiet icon buttons out to the real thing — **Spotify** and its **Apple Music** twin — shown when the row carries that link. There is no capture-source link: the capture pipeline stores an R2 key and byte count, not a source URL, so there is nothing honest to link to.
- **Log it** — certify this EXISTING row in place. It mints only the certification half (`certify_track`, reusing the Spotify add's exact coordinate mint), so it never creates a second `tracks` row; the fresh finding enters the enrichment chain (`enrichment_status` defaults to `pending`) and the operator is routed to the findings board to finish the note / galaxy / publish. **OPERATOR tier** — certifying is the one act the whole catalogue domain forbids a machine.
- **Not for me** — a reversible veto (`set_track_dismissed`). It stamps `dismissed_at`, so the row drops out of the ear + capture lenses, the rank sweep, and the capture work queue (the ruled-out-label veto's class — a metered download is never spent on a dismissed row). It is undone by the toast's Undo or from the **Dismissed** lens, which restores it into the ranking on the next sweep tick. **OPERATOR tier** — steering what the telescope keeps pointing at is a taste ruling.

## The ops

Both `adminAuth` (operator **or** agent), registered in the contract as `admin-catalogue`:

- **`list_catalogue_tracks`** → `GET /admin/catalogue?lens=&limit=` — the ranked read + the summary. `lens` is `ear` | `capture` | `quarantine` | `dismissed`.
- **`rank_catalogue`** → `POST /admin/catalogue/rank?limit=` — one tick of the sweep. `remaining > 0` means run it again.
- **`clear_wrong_audio`** → `POST /admin/catalogue/wrong-audio/clear` — the operator's override on the wrong-audio quarantine (§ Wrong audio). **OPERATOR tier**, unlike the two above: an agent does not get to reverse the machine's verdict on its own output.
- **`force_capture`** → `POST /admin/catalogue/force-capture` — the dupe-veto escape hatch (§ Duplicates): lift a WRONG duplicate veto so the row is captured anyway. **OPERATOR tier**, the `clear_wrong_audio` class — overruling the machine's own duplicate verdict is not an agent's call.
- **`certify_track`** → `POST /admin/catalogue/certify` — **Log it**: certify an existing catalogue row in place, minting only its finding (§ The operator's actions). **OPERATOR tier**: an agent may never certify.
- **`set_track_dismissed`** → `PUT /admin/catalogue/dismissed` — **Not for me** / restore, the `set_capture_budget` shape (one op, both directions). **OPERATOR tier**: a taste ruling, not a machine job.

`rank_catalogue` is **agent-allowed, not operator-tier** (the `update_galaxy_map` precedent): it writes only _derived_ ranking columns, and only on catalogue rows. It cannot mint a coordinate, write a note, or certify anything — those columns do not exist on the rows it can reach. The three OPERATOR-tier ops are the acts that change what the archive _is_ (a certification) or what the telescope _points at_ (a dismissal, a quarantine override) — the `update_label` / `set_capture_budget` class.

The CLI mirrors them, and holds no ranking logic of its own:

```bash
fluncle admin catalogue rank --limit 250 --json    # one tick — the sweep a cron drives
fluncle admin catalogue list --lens ear            # the telescope
fluncle admin catalogue list --lens capture        # what to capture next
fluncle admin catalogue list --lens quarantine     # the wrong-audio holding pen
fluncle admin catalogue clear-wrong-audio <id>     # keep a capture the sweep flagged (operator)
fluncle admin catalogue force-capture <id>         # overrule a wrong duplicate veto — capture it anyway (operator)
fluncle admin catalogue certify <id> [--note …]    # log an existing catalogue row in place (operator)
fluncle admin catalogue dismiss <id>               # "not for me" — out of ranking + capture (operator)
fluncle admin catalogue restore <id>               # put a dismissed row back (operator)
```

## Where it stands

**The catalogue is empty today.** The crawler that fills it is a separate unit; until it lands, `/admin/catalogue` renders its truthful empty state and the sweep is a no-op. Everything downstream of a catalogue row — the ranking, the two lenses, the ladder — is built, tested against real vectors on a real libSQL engine, and waiting.

**The periodic cron landed with the crawler**, exactly as this section asked: a timer that ranks an empty table would be a `/status` row that means nothing, and [the crawler](./catalogue-crawler.md) is what creates rows. It is now the on-box **`fluncle-rank`** sweep — every 30m, trailing the crawl's 10m, draining the stale set rather than taking one bite of it ([docs/agents/hermes/rank-timer/](./agents/hermes/rank-timer/README.md); box activation is operator-gated). The **Re-rank** button and the CLI remain the same op, for when the operator wants it now.

## Files

- `apps/web/src/lib/server/catalogue.ts` — the sweep, the ladder, and the two reads.
- `apps/web/src/lib/server/catalogue.integration.test.ts` — **the ranking proof** (real vectors, real SQL, the centroid case).
- `apps/web/src/lib/server/catalogue.test.ts` — the pure ladder + the staleness fingerprint.
- `apps/web/src/routes/admin/catalogue.tsx` — the station (and the capture-budget card).
- `packages/contracts/src/orpc/admin-catalogue.ts` + `apps/web/src/lib/server/orpc/admin-catalogue.ts` — the ops.
- `apps/cli/src/commands/admin-catalogue.ts` — the thin HTTP client.

The capture budget (the brake):

- `apps/web/src/lib/server/capture-budget.ts` — the switch, the caps, the rolling-24h ledger, the verdict.
- `apps/web/src/lib/server/capture-budget.test.ts` — the pure decision core (default-deny, the `>=` cap edge, the malformed-value fallback).
- `apps/web/src/lib/server/capture-budget.integration.test.ts` — the ledger's SQL: catalogue-only, attempts-not-successes, the rolling window.
- `apps/web/src/lib/server/track-work.ts` — **where the brake is applied** (the queue narrows to the findings when the budget is shut).
- `apps/web/src/lib/server/track-work.integration.test.ts` — **the three proofs**.
- `apps/cli/src/commands/capture.ts` — `fluncle admin capture`.

The verification gate (§ Wrong audio · the gate + the backfill):

- `docs/agents/hermes/scripts/fingerprint-match.ts` — the shared Chromaprint matcher (the threshold + its reasoning), the fpcalc/preview I/O, and the rejection-memory helpers; `fingerprint-match.test.ts` proves the sliding-window match on synthetic fingerprints.
- `docs/agents/hermes/scripts/capture-sweep.ts` — the ingest gate (verify → store/reject/abstain) + the demoted channel trust; `capture-sweep.test.ts` encodes the no-waiver rule.
- `docs/agents/hermes/scripts/verify-captures.ts` + `.sh` + `../verify-captures-timer/` — the historic backfill (measure on the box, route on the Worker); `verify-captures.test.ts` proves the tick's skip-not-stamp discipline.
- `apps/web/src/lib/server/capture-verify.integration.test.ts` — **the routing proof** (catalogue mismatch quarantines; a finding mismatch is only stamped; a stamped row leaves the worklist).
