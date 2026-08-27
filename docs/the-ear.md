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

| column                     | what it holds                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nearest_finding_score`    | cosine similarity to the nearest finding (`1 − vector_distance_cos`, so higher is nearer). The Ear's sort key.                                            |
| `nearest_finding_track_id` | **which** finding. The row's WHY.                                                                                                                         |
| `capture_priority`         | −3…3, the pre-audio ladder (−1 a ruled-out label, −2 a duplicate, −3 unauthorized). The capture queue's sort key.                                         |
| `duplicate_of_track_id`    | the finding OR canonical catalogue sibling this row is the SAME RECORDING as. The duplicate's WHY — see _Duplicates_.                                     |
| `catalogue_rank_corpus`    | the corpus fingerprint the values above were computed against, `"<logic-version>:<findings>:<embedded>:<qualified-count>:<qualified-digest>"`. Staleness. |
| `catalogue_ranked_at`      | when. Freshness for the operator; never a predicate.                                                                                                      |

The Ear read uses `tracks_catalogue_ear_idx` (`is_catalogue`, `dismissed_at`, `nearest_finding_score`, `track_id`) so the active catalogue slice and stable score order share one composite walk. Capture ordering uses `tracks_capture_priority_idx`. NULLs sort first in an ASC index, so a DESC walk reaches ranked rows first and stops at the page's `LIMIT` — the cost is the page, not the corpus.

### The three database rules, all load-bearing

Per [docs/local-database.md](./local-database.md):

1. **Rank in SQL.** `vector_distance_cos(candidate.vec, finding.vec)` runs in the database and only the winners come back — two scalars per candidate. Pulling vectors into the isolate to rank them is what OOMs the 128 MB Worker.
2. **Both sides of the distance are stored BLOB columns**, never a bound text vector. (The 14× text-probe cliff is about _binding_ a probe; there is no probe here — this is a column-to-column join, which never re-parses anything.)
3. **No ANN index.** Use an exact scan bounded to `batch × findings`; do not create an ANN index on the system-of-record table.

### Self-healing, by fingerprint

Staleness has two halves. The **corpus half** is a fingerprint stored on every ranked row: `"<version>:<findings>:<embedded findings>:<qualified-artist set size>:<set digest>"`. The two finding counts move whenever the corpus side could change (log a finding, or embed one). The **qualified-artist set** (its size, plus a digest — see below) moves whenever a SECOND-ORDER authorization change could happen (RFC artist-primary-capture): an artist crossing the qualification line (a certified finding, or a weighted release count ≥ 3 on `enabled` labels) flips the answer for _every_ catalogue track that credits them — an unbounded, un-enumerable fan-out that a global re-stale is the right tool for. A row whose stored fingerprint differs from the live one is stale and re-ranks on a later tick. A leading logic version (`v5`) forces one self-healing full re-rank when the sweep's algorithm itself changes.

Staleness combines a qualified-artist-set fingerprint with targeted invalidation: null a track's rank when its artist edges change, null a label's tracks when its ruling changes, and re-rank a vectored row that still carries a non-negative pre-audio tier.

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

Capture authorization uses artist identity and label rulings; BPM is not an authorization, capture, or crawl gate. Preview BPM is unreliable because a preview may contain only a beatless intro. Full-song BPM remains analysis metadata after capture.

**AUTHORIZATION** is the gate: a row may be bought iff **(a credited artist is QUALIFIED) OR (its label is `enabled`)**, and never when its label is `disabled` (the veto). A **QUALIFIED artist** is one with a certified finding **OR** a weighted release count ≥ **3** on `enabled` labels (primary credit 1.0, `remixer` 0.5) — matched by **identity through the `track_artists` graph** (`artists.id`), never a name-fold, because a name string is not enough identity to spend money on. An edge-less row (no graph edge yet — ~2/3 of the catalogue until the graph backfill drains) can authorize **only** via its `enabled` label.

**PRIORITY** is the ordering among the rows that passed the gate — the old explainable ladder, kept as a hint so the operator can still see why a track is next:

| tier | rung            | the claim                                                                                                                                                    |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✗    | `skipped-label` | **the veto, checked first.** Its label is one the operator ruled `disabled`. Tier **−1**, whatever else is true of the track.                                |
| ✗    | `unauthorized`  | no credited artist is qualified and the label is not `enabled`. Tier **−3** — metadata welcome, money withheld. Flips the moment an artist qualifies.        |
| 3    | `artist`        | a credited artist is **qualified** (identity), or a name on it is already on a finding. His ear has said yes to this artist — the strongest signal there is. |
| 2    | `label`         | its (authorizing) label already carries a finding. A crate he digs in — but a **hint** now, reachable only once the row is authorized.                       |
| 1    | `seed-label`    | its label is `enabled` ([docs/label-entity.md](./label-entity.md)), nothing certified on it yet. In-lane, unproven.                                          |
| 0    | `none`          | authorized with no ordering hint (unreachable in practice; kept for legacy rows).                                                                            |

**Why authorization moves off the label.** A finding on a label is a priority hint, not authorization for that label's catalogue.

**The two negatives share one rail.** Both `skipped-label` (−1) and `unauthorized` (−3) are excluded from the capture queue by the single `capture_priority >= 0` predicate (`track-work.ts`) — no new mechanism, one more value on a rail that already exists. They differ in how permanent the reason is: `skipped-label` is the operator's explicit ruling ("not your lane"); `unauthorized` is the softer default withholding, the one most likely to flip to authorized as the artist graph fills or a label is enabled. Their board order (a DESC read) is by how **specific** the reason is: the explicit ruling (−1) and the identity fact of a duplicate (−2) sort above the generic "not qualified yet" (−3).

**The veto is checked first.** A `disabled` label vetoes capture even when a credited artist is otherwise qualified.

And none of it breaches the crawl-scope-never-storage rule. A ruling governs what Fluncle _acquires_ next, and a capture **is** an acquisition — the same class of act as a crawl, just further down the same pipe. Nothing stored moves: the track keeps its row, keeps appearing in the capture lens, and keeps an honest reason line. It is ordered last, never deleted, hidden, or changed. This is the one sanctioned way `seed_state` reaches the ranking, and it decides an ORDER, never a visibility.

`capturePriorityFor` is **pure**, and it is the ladder's single authority: the sweep calls it to _write_ the tier, and the surface calls it to _explain_ the tier. They cannot drift, because they are the same function (the operator-authorization floor for a `force_capture`d row is applied by the same shared wrapper on both paths). Label matching goes through `labelSlug` — the same fold that makes `Pilot.` and `Pilot` one label everywhere else.

The two lenses are **disjoint by construction**: scoring a track clears its `capture_priority` (it has audio, so capturing it again is the one thing the queue must never ask for), and the capture lens is exactly "catalogue, no score yet".

**Each negative tier is its own value, and that is what makes it enforceable.** The veto first shipped sharing `none`'s 0, which left it invisible to SQL — the capture _work queue_ could not tell "capture this last" from "never spend a metered per-GB byte on this", so it could only ever be a sort. And a sort is not a veto: the queue drains, and last arrives. At its own negative value it is a predicate (`capture_priority >= 0`), and every display property above survives untouched — the row keeps its place in the capture lens, still sorts last, still carries its honest reason line. Ordered last, kept anyway, and never bought.

`capture_priority` is what the **work queues** ([docs/gpu-batch-embed.md](./gpu-batch-embed.md)) actually drain on: `list_track_work` serves capture, analysis, and embedding off `tracks`, ordered certified-first and then by this ladder. The veto is scoped to **capture** alone — a ruling governs what Fluncle _acquires_, not what he may _measure_, so a vetoed track whose bytes are already on file is still analysed and embedded (and its vector is how The Ear gets to disagree with the ladder).

**Artist rules do not touch this ladder.** The crawler's per-artist allow/block exceptions ([catalogue-crawler.md](./catalogue-crawler.md#the-boundary-gate-enabled-label-storage--graph-distance-discovery)) are storage-scope only: a blocked artist's already-stored rows keep their tier, and an allowed artist's newly stored rows enter the ladder like any other catalogue row. Folding scope into the spend ladder is deliberately deferred until credit MBIDs are persisted per track — until then the ladder cannot see who a row's first credit is, and a half-blind veto would misfire.

This repo does **not** build the capture itself — the acquisition layer lives in the private companion repo (the-archive RFC, D6). The Ear ships the queue and the priority signal; the layer that acts on them reads `capture_priority` and works down.

## The long-form veto — a mix is not a track

Exclude catalogue recordings at or above `LONG_FORM_MS` (15 minutes) from both Ear lenses and catalogue capture. Long-form mean-pooled vectors behave like multi-track centroids and do not represent a single discoverable recording.

## Duplicates — already in the archive

Duplicate detection uses four signals: finding ISRC equality before capture; near-identical post-embed similarity; catalogue-sibling identity by `matchKey` or ISRC; and finding `matchKey` equality. All write the same canonical `duplicate_of_track_id` and tier −2 rail, with finding matches preferred over catalogue siblings.

Catalogue-sibling identity is served by the maintained `track_duplicate_keys` projection, one row per track with the shared TypeScript `matchKey` and normalized ISRC. Track mints and ISRC repairs update it atomically with `tracks`; the deploy backfill fills missing history in resumable 250-row transactions and refuses completion unless its row count equals `tracks`. A rank tick looks up only the distinct keys carried by its candidate batch, then joins `tracks` for live capture, vector, dismissal, and force-clear state. Canonical choice is therefore unchanged — vector-bearing first, then smallest `track_id` — without reading the captured corpus into the Worker.

All four surface the **same honest register**: the row stays visible (ordered last on the capture lens, still shown on the ear lens), it **names the row it duplicates**, and it is never silently hidden — the-ear.md's display promise holds for a duplicate exactly as for a vetoed label.

**It stays self-healing.** The pre-audio marker rides the same fingerprint staleness as everything else: `duplicate_of_track_id` is re-written every time a row is re-ranked, so it clears on its own when the finding it matched is deleted (the corpus fingerprint moves, the row goes stale, the next tick re-ranks it and finds no match). A stamped duplicate is not re-picked — no loop — and the scoring path nulls the marker along with `capture_priority`, keeping the two lenses disjoint.

**The escape hatch — `force_capture`.** All four detectors can be WRONG in rare cases: a shared or mis-assigned ISRC, or a `matchKey` collision on a genuinely different recording (two distinct tracks that fold to the same title+artist identity — the matchKey detector's false-positive class). And the veto is **self-sealing** — an uncaptured row marked a duplicate is excluded from capture forever, so the post-audio similarity check that would _exonerate_ it never runs (it never gets audio to embed). `force_capture` (**operator tier**, the `clear_wrong_audio` sibling for the other self-sealing verdict) is the only exit. It stamps a **sticky `capture_status = 'duplicate-cleared'` sentinel** that all four detectors respect before re-stamping — so the self-healing re-rank never re-marks the row — and in the same write it lifts the veto (`duplicate_of_track_id` null, tier cleared) and nulls the corpus fingerprint so the next tick re-ranks the row onto the pre-audio ladder at its **honest tier**; the next open-budget capture tick then buys it (the capture work queue treats an uncaptured `duplicate-cleared` row as capture-eligible). It **bypasses the DUPLICATE veto, never the VERIFICATION gate**: a re-captured forced row still runs the ingest fingerprint gate, and a wrong-audio (cross-title near-1.0) capture still quarantines. Getting the row captured is the point — its OWN vector is what lets the finding-side detectors settle it honestly. **And the sentinel survives the capture it enables**: the generic update path's ruling guard (track-update.ts) never lets the capture sweep's terminal PATCH (`done`/`failed`/`unmatched`) overwrite `duplicate-cleared` — an operator ruling is never clobbered by a machine write, the auto-note's fill-empty-only class — so the post-embed re-rank still honours the ruling, and the capture queue schedules a forced row off the audio key + attempt stamps instead of the status (a captured forced row never re-enters the queue; a failed one backs off like any failed row). It surfaces as a quiet **"Capture anyway"** control beside the "already in the archive" marker on the capture lens.

## Wrong audio — the capture that lied

A near-identical vector with a different `matchKey` indicates wrong captured audio rather than a duplicate. Quarantine that capture, retain its rejected-byte identity, and verify every future download against an official preview with the shared Chromaprint matcher before storing it.

**The mechanism is Chromaprint.** After a candidate downloads, the sweep fetches the track's preview through the same `/api/preview` relay the site uses, fingerprints both files with `fpcalc -raw -json`, and runs a **sliding-window bit-error match**: does the preview's fingerprint appear as a contiguous window anywhere inside the capture's, within `DEFAULT_MAX_BER` (0.20 — AcoustID practice is <0.15 for same-source audio; widened for our cross-source Deezer-preview-vs-YouTube-capture pair, still far below the ~0.45+ different-recording regime; env-overridable via `FLUNCLE_VERIFY_MAX_BER`)? The matcher lives in one shared module (`fingerprint-match.ts`) so the ingest gate and the backfill below cannot drift. The preview is a verification **reference only** — it never feeds a vector and is never stored as analysis input (full-audio-only is ratified).

**The three verdicts, and the honesty rule.** A MATCH stores as before, stamped `capture_verification = 'preview-match'`. A MISMATCH **rejects the candidate before storing** — nothing to quarantine because the bad bytes never land — remembers it (below), and walks to the next ranked candidate; all candidates exhausted lands the honest `unmatched`. NO PREVIEW SOURCE (or no fpcalc on the box yet) and the gate **abstains**: capture proceeds, stamped `'unverified'` — never a silent pass, never a block on a track with no reference. `null` means pre-gate legacy.

**Channel trust is demoted.** The trusted-channel path still helps rank candidates, but it does not widen the duration guard. Nothing skips the gate.

Rank `<Artist> - Topic` channels as strong candidates. When the primary search returns zero raw candidates, allow one de-constrained fallback using the primary artist and version-stripped title. Cap search variants with `FLUNCLE_CAPTURE_QUERY_VARIANTS`.

**The rejection memory** — `source_audio_rejected`, a JSON array on `tracks` of `{ videoId, sha256, reason, at }`, capped at the newest ~10. It generalizes the old single-sha memory (the digest embedded in a quarantined row's kept `source_audio_key`, which still works for pre-memory rows): the **videoId is the pre-download filter** — a known-bad candidate never costs proxy bytes again — and the **sha256 is the deep backstop** — the same audio re-uploaded under a new id is rejected post-download and remembered. Every rewind grows it: the gate's fingerprint mismatch, the rank sweep's quarantine, and the operator's `flag_wrong_audio`.

### The backfill — every historic capture gets the same check

`fluncle-verify-captures` processes captures whose verification is null. Use ISRC-resolved previews for match or mismatch verdicts. For ISRC-less rows, a title-and-artist reference may confirm a match only after identity, duration, and ambiguity guards; it may never issue a mismatch.

## The capture budget — the brake

The ladder above decides **what** the metered GB buy. It has nothing to say about **how much**, and at catalogue scale that gap is the one that costs real money.

Catalogue capture is metered. At four tracks every five minutes, an unbounded queue can issue roughly 1,150 downloads per day, so the catalogue worklist is governed by a default-deny switch plus rolling count and byte caps.

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

### Catalogue capture activation

`fluncle-capture` reads the budget-gated `scope=all` queue. While paused, it receives findings only; resuming the budget admits catalogue rows up to the configured caps.

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

The diversified Ear top mirrors to the private "Fluncle's Telescope" Spotify playlist. Store the playlist ID in `telescope.spotify_playlist_id`, replace items through `/playlists/{id}/items`, and skip writes when the desired URI hash is unchanged.

## The per-user telescopes — the engine, generalized to the crew

The operator's telescope above answers "what sits near what **he** loves". The per-user recommendation engine (`recommendations.ts`) asks the same question for a **signed-in listener**: they pick up to 12 seed tracks — archive or catalogue, because a listener seeds with what they like, not with what Fluncle certified — and the engine ranks the embedded, Spotify-anchored catalogue against **their** seeds. Same physics, different pointing.

**The ops**, all on the `/me` private-session tier (cookie session; the writes CSRF-guarded): `list_private_rec_seeds` / `save_private_rec_seed` / `delete_private_rec_seed` (`/me/rec-seeds` — the seed set, capped at 12, the cap enforced on the write with an honest 409) and `list_private_recommendations` (`/me/recommendations` — the engine). The engine's read additionally requires a **verified email** (403 `email_unverified` — the learning-cohort ruling) and carries a modest per-user hourly rate limit: each request is a real vector scan.

**The scan is this page's machinery, reused, not re-derived.** Each candidate's score is max-similarity across the seed set (`min` over cosine distances, ONE pass with a distance term per probe folded by scalar `min(…)` in the select list — never a `union all` branch per probe over a CTE, which the planner flattens and re-executes once per branch; each probe bound as a raw BLOB), ranked and cut **in SQL**; the seed cap IS the probe fan-out bound. The candidate exclusions are the ear lens's own (no findings row, not dismissed, no duplicate marker, the display-band duplicate cut, the long-form veto) plus the Spotify anchor, and the page is spread by the **same** `EAR_DIVERSITY_DECAY` greedy re-rank (`diversifyRanked`) the ear lens uses — the score a row displays stays the true similarity. Computed per request, no cache in v1: the scan is bounded (≤12 probes) and the rate limit meters it. A seed whose track has no vector yet is skipped **honestly** — named in `seedsSkipped`, never silently ignored.

**The blend (option B) is the register split on the wire.** The response is two lists. `findings` — the 2–3 certified findings nearest the seed set — are the labeled slots Fluncle's full voice rides: each carries its Log ID and note (its WHY, his testimony). `catalogue` rows carry **nothing editorial**: identity, listen-out links, and the honest similarity number — the instrument register, DESIGN.md's Unlit Rule on the wire ("close to what you picked" is UI copy, not data). And a row the user seeded is never recommended back to them, in either half.

The seed set joins the account's privacy invariant like every per-user table: exported with the account data, deleted in the account-deletion batch (`account-data.ts`).

## Fluncle's Frontier — the per-user playlist, shipped DARK

The engine above computes a listener's recommendations on demand. **Fluncle's Frontier** (E2, `frontier-playlist.ts`) turns that computation into a **durable, shareable artifact**: every verified user can mint ONE **public** playlist named "Fluncle's Frontier" on **Fluncle's OWN Spotify account** — no per-user OAuth, so the dev-mode 5-user allow-list never binds — holding their current recommendations (the E1 blend: the findings slots first, then the anchored catalogue recs, de-duped), refreshed weekly. It is the operator's Telescope mirror generalized to the crew: a full-replace reflection of a ranking, never hand-curated. A playlist in someone's Spotify is reach that markets the archive every week.

**Four brakes, all default-safe** — the feature ships DARK:

- **The kill switch** (`frontier.minting`, the `settings` KV) is **DEFAULT-DENY**, the exact inversion the capture budget + publish-advance ship: only the literal string `"true"` opens minting. An unset key, a fresh deploy, a preview branch, a lost row — every one reads as CLOSED. It gates only the EXTERNAL Spotify effect: the mint op and the paced drain still write the internal EDITION (the recommendation ledger the shelf reads — the mint returns `edition_only`) and skip only the Spotify write. The machine can create a playlist on the operator's account only because he deliberately wrote `"true"`.
- **A rolling daily mint cap** (`FRONTIER_DAILY_MINT_CAP`, ~20) bounds NEW playlist creations inside a rolling 24h window (a refresh of an existing playlist is never capped) — the blast radius of a bug.
- **A per-row mirror guard**: the desired URI list's sha256 is stored on the row (`last_uri_hash`); an unchanged list skips the Spotify PUT entirely, so a quiet week is one read, not a needless write (the Telescope's discipline). The item replace is `PUT /playlists/{id}/items` — the proven endpoint, never the legacy `/tracks` alias. Every Spotify call is best-effort: a fault returns `{ ok: false, reason }`, never a throw.
- **The shared Spotify budget** (`spotify-budget.ts`, the sibling of the Apple call meter): Spotify rate-limits per-APP over a ~30s rolling window shared by every Spotify path, so both write paths consult a shared fixed-window meter (`isSpotifyCallBudgetAvailable`) and record each write (`recordSpotifyCall`). A live signup's mint runs synchronously when the window has room and DEFERS (status `building`, the edition already written) when it is spent — the paced drain completes the owed write in a fresh window, so a user never eats a 429 in their face.

**The description is personalized** and stays in the crew-facing register (VOICE.md): _"Dug for @<username> from the archive. Fresh bangers every week. fluncle.com"_ — sentence case, no em dashes, ≤300 chars.

**The ops**: `mint_private_frontier_playlist` / `get_private_frontier_playlist` on the `/me` private-session tier (the mint is CSRF-guarded, verified-email gated, rate-limited 4/h; the read returns the playlist URL + last-sync + `mintingOpen` so the page messages honestly), and `refresh_frontier_playlists` on the **admin (agent-allowed)** tier — the `fluncle-frontier-refresh` box cron (every ~15 min) drains one paced BATCH of DUE playlists with the box's agent token (the `advance_publish_queue` / `rank_catalogue` precedent: the Worker owns the Spotify grant, the box only triggers). Each tick processes pending mints first, then users whose per-user cursor (`user_frontier_refresh`) is older than ~6 days, and stops cleanly when the shared Spotify budget is spent — so the whole crew still refreshes ~weekly, spread across the day rather than bursting at one wall-clock slot. It creates no new public authority — every playlist it touches already exists, minted by its own owner.

**The cover is a NODE-SIDE leg, and honestly so.** A custom per-user cover is a Remotion render (`@fluncle/media`'s `FrontierCover` — the Nostalgic Cosmos base + the crew № stamped in a corner). Remotion needs a real headless Chromium and does **not** run in a Cloudflare Worker, so the render cannot happen where the playlist is minted. The split: the Worker mint leaves `cover_uploaded_at` NULL; the Node-side script `apps/web/scripts/render-frontier-covers.ts` (operator-run) reads the "`cover_uploaded_at IS NULL`" worklist, renders each cover, and calls `putFrontierCover` (a plain Spotify `PUT /playlists/{id}/images`) to upload it. That upload leg is **INERT** until the operator re-auths the grant with the `ugc-image-upload` scope: every PUT 403s the missing scope, degrades to `{ uploaded: false, reason: "missing_scope" }`, and stamps nothing — so the row stays queued and the retry costs nothing.

The Frontier row (`user_frontier_playlists`) joins the account's privacy invariant like every per-user table — deleted in the account-deletion batch (`account-data.ts`).

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

`fluncle-rank` runs every 30 minutes after the crawler and drains the stale ranking set. The Re-rank control and CLI invoke the same bounded ranking operation on demand.

## Files

- `apps/web/src/lib/server/catalogue.ts` — the sweep, the ladder, and the two reads.
- `apps/web/src/lib/server/catalogue.integration.test.ts` — **the ranking proof** (real vectors, real SQL, the centroid case).
- `apps/web/src/lib/server/catalogue.test.ts` — the pure ladder + the staleness fingerprint.
- `apps/web/src/routes/admin/catalogue.tsx` — the station (and the capture-budget card).
- `packages/contracts/src/orpc/admin-catalogue.ts` + `apps/web/src/lib/server/orpc/admin-catalogue.ts` — the ops.
- `apps/cli/src/commands/admin-catalogue.ts` — the thin HTTP client.

The per-user telescopes (§ above):

- `apps/web/src/lib/server/recommendations.ts` — the seeds + the engine (the blend, the exclusions, the honest skip).
- `apps/web/src/lib/server/recommendations.integration.test.ts` — **the engine's proof** (real vectors, real SQL: the cap, the scoping, every exclusion, the slots' voice, the decay, the max-sim/centroid case, the 403 gate).
- `packages/contracts/src/orpc/me-recs.ts` + `apps/web/src/lib/server/orpc/me-recs.ts` — the four `/me` ops.

Fluncle's Frontier (§ above — the per-user playlist, shipped DARK):

- `apps/web/src/lib/server/frontier-playlist.ts` — the kill switch, the daily mint cap, mint-or-refresh (the mirror guard + the shared-Spotify-budget defer), the paced `refreshAllFrontierPlaylists` drain (the per-user cursor + due-gate), and the cover upload leg (`putFrontierCover` + the worklist).
- `apps/web/src/lib/server/frontier-playlist.integration.test.ts` — **the behaviour proof** (switch-off makes no Spotify call, create-once idempotence, the URI order, the description, the mirror guard, the daily cap, the sweep's iteration, the scope-failure degradation).
- `packages/contracts/src/orpc/me-frontier.ts` + `apps/web/src/lib/server/orpc/me-frontier.ts` — the two `/me` ops (mint + read).
- `packages/contracts/src/orpc/admin-frontier.ts` + `apps/web/src/lib/server/orpc/admin-frontier.ts` — the admin `refresh_frontier_playlists` op; `apps/cli/src/commands/admin-frontier.ts` is the thin client.
- `packages/media/src/remotion/frontier-cover.tsx` + `packages/media/src/render/render-frontier-cover.ts` — the Node-side cover render; `apps/web/scripts/render-frontier-covers.ts` is the operator-run render + upload driver.
- `docs/agents/hermes/scripts/frontier-refresh-sweep.{ts,sh}` (+ `.test.ts`) + `docs/agents/hermes/frontier-refresh-timer/` — the paced `fluncle-frontier-refresh` cron (every ~15 min).

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
