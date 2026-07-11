# RFC: The Catalogue — Fluncle becomes drum & bass's living reference

**Status:** Final (research → /taste → 4-role adversarial panel synthesized, 2026-07-11) — completeness standard applied.
**For:** a fresh build session or a fleet of worktree sub-agents.
**Canon/authority:** `LORE.md`, `PRODUCT.md`, `DESIGN.md`, `VOICE.md`, and the codebase arbitrate. This is planning, not specification. **Prune this file once built.**

> Process note: five divergent research threads (data model + identity; graph discovery + box capacity; storage/search at 100k; surfaces + SEO/GEO; `/mix` as front door), a taste pass, and a four-role adversarial panel (staff engineer, brand/canon, SEO/GEO, product/scope). **The panel overturned three of the draft's headline decisions.** Their corrections are baked in; the reversals are recorded in §11 so they are not re-litigated. Verifications in the appendix.

---

## The standard (definition of done)

Nothing here is deferred or optional. Every unit ships complete — implementation, tests, and docs — or it does not ship. The sequencing below is **ordering a complete delivery**, not a menu to cut from.

- **Tests and docs are part of done**, in the acceptance criteria, not a follow-up.
- The only sanctioned "not now" is a true dependency chain (the engine must be proven before the crawl is bought) or an outcome outside our control (whether Google indexes a page, whether an LLM cites us).
- **Dangling threads this build ties off:** the triplicated feed SQL; the `artists_text`/`title_text` snapshot hack in `recording_cues` + `mixtape_tracks`; the unindexed `tracks` table; `getSimilarFindings`' unbounded scan and `getRandomTrack`'s `order by random()` (**live bugs today**, not catalogue prerequisites); the 51 byte-identical `artistSignatureLine` templates; and the provisional `SONIC_CALIBRATION` constants.

---

## 0. Summary — the reframe

### CORRECTION (2026-07-11, verified live — supersedes the draft's headline)

The draft's headline claim was **"the engine is dead right now, at n=60"**, read off the `mixability.ts` header comment (`embedding_json` 3/56, "the sonic term is DORMANT"). **That comment was stale and the claim is FALSE.** Verified against production on 2026-07-11:

- **All 60 findings carry an `embedding_json` vector.** Proof: all 60 are assigned to a sonic galaxy, and galaxy assignment is impossible without a vector (`cluster-sweep` fit `corpus: 60, reassigned: 60`).
- `sonicGateOpen(60)` ⇒ **1,770 pairs ≥ `MIN_EMBEDDED_PAIRS` (50)** ⇒ **the sonic term is LIVE in `/mix` today.** It activated with zero code change, exactly as it was designed to.
- The embed cron drained during 2026-07-10; the source comment outlived its truth by a day and misled this RFC. The comment has since been corrected in the code.

**The question the draft said this RFC rests on — "does MuQ cosine actually separate liquid from neuro?" — is therefore already ANSWERED, and the answer is YES:** the k=4 cluster fit over those 60 vectors produced four regions the operator could name by ear (Solar / Lunar / Pulsar / Nebular), and reported that the cover-art rows alone telegraphed each galaxy's character before he heard a note. The retrieval space works at n=60.

**What survives, and is now MORE urgent, not less:** Unit 0's bug list below is real and independent of coverage. In fact the sonic term being LIVE makes BUG 1 and BUG 2 **live production defects today** — an unkeyed-but-embedded finding currently outranks a perfectly-scored one, and the calibration constants went live provisional. **Unit 0 remains the critical path; only its framing changes — it is a bug fix on a running engine, not a resuscitation of a dead one.**

### The purpose reframe: the catalogue is not a catalog. It is fuel — and its first customer is the operator, not the public.

The catalogue's job is to make the **embedding space dense**. With 3 vectors, MuQ similarity is nothing. With 10k+ it becomes a real retrieval space, and the sonic term turns on.

But the panel found the sharper truth. **Fluncle's binding constraint is not "the archive is small." It is "Maurice can only find ~60 bangers a year, by hand, one at a time."** A catalogue with embeddings, ranked _"closest to your findings, not yet logged,"_ is **a discovery engine for the operator** — it makes the _findings_ pipeline faster, and the findings are the entire equity. That version needs no public `/mix`, no taste-seeding, no SEO surfaces, and **no 100k**.

So the catalogue has two customers, and they arrive in order:

1. **The operator** — a certification queue. _Ships first, needs ~10k rows, and pays for itself if it surfaces one banger Maurice would have missed._
2. **The public** — `/mix`, artist/label pages, search. _Ships only after the engine is proven._

### The implementation reframe: the Log ID _is_ the tier.

Fluncle already has a ratified pattern for "a real object that is deliberately not a spine object." A `recording` is _"deliberately COORDINATE-LESS — no `logId`, no spine entry"_ and only `promote_recording` mints one. A `clip` carries _"NO Log ID — the spine namespace is scarce/collectible."_ **The catalogue is the third instance of that exact idea.** No Log ID ⇒ no voice, no video, no note, no galaxy, no publish — enforced **by absence** (a separate table without those columns), not by discipline.

### The LORE reframe: the catalogue is the unvisited sky.

The draft had no fiction, and a layer defined purely by absence gets quietly re-narrated by whoever ships the next feature. The answer was already in canon. LORE.md: _"each finding is a **star** — a waypoint, a marker dropped at the spot in the Galaxy where Fluncle had the experience."_

**A galaxy is not sixty stars. It is full of them. The findings are the ones he has _been to_. The catalogue is the rest of the sky: lights his instruments can measure without him ever standing there.**

That is literally what the data model holds — BPM, key, spectral features, a MuQ vector. **Instrument readings.** And every firewall now falls out of the fiction instead of out of a policy memo:

| Firewall                                      | Fiction reason                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| No Log ID                                     | a coordinate marks **where he stood**. He never stood there.                    |
| No note, no observation, no video             | he has nothing to say about a place he hasn't been. There is no trip to relive. |
| No star in the Galaxy game                    | you cannot fly to a waypoint that was never dropped.                            |
| No voice                                      | **a telescope does not narrate.**                                               |
| Promotion = `publishTrack`, never a flag flip | **he goes there.** A light he had only measured becomes a place he stood.       |

And it draws the line the draft was missing. "No voice" is under-specified in exactly the direction that produces dead copy. The real rule:

> **Fluncle may narrate his own absence. He may never characterise the track.**

He can say _"I haven't been to these ones."_ He can never say what one **is**. That is testable, it keeps the certification firewall absolute, and it gives the section the one line of voice it needs to _teach_ the distinction instead of assuming the visitor infers it. **This belongs in LORE.md, ratified, before any catalogue surface ships.**

### The decomposition

**The true dependency graph is `crawler → table`. Everything else is falsely coupled by sharing a schema.**

| Unit                                                                                      | Real dependency     | Delivers value alone?                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **0. Wake the engine** (drain the 60 embeds, fix BUGs 1–3, calibrate)                     | **none**            | **YES — fixes the shipped `/log` "more like this" row and turns on `/mix`'s differentiator, at n=60, with zero new tables** |
| **1. The catalogue-free wins** (artist gate, `labels` table, the two unbounded-scan bugs) | none                | YES — 10× indexable surface, no catalogue rows involved                                                                     |
| **2. Unit A** — `catalogue_tracks` + identity + the tier-coverage test                    | none                | no (substrate, honestly)                                                                                                    |
| **3. The operator's dig** — 10k rows + `/admin/catalogue` promote queue                   | A                   | **YES — the highest-confidence value in the RFC**                                                                           |
| **4.** Storage (vectors/FTS), public surfaces, public `/mix`                              | A + evidence from 3 | only if 0 and 3 succeed                                                                                                     |

---

## 1. Context & goals

Fluncle today is ~60 operator-certified findings, each a heavy hand-made object (coordinate, video, note, spoken observation, publish, galaxy). **That is the product and it is not changing.**

**Why now — Fluncle is already hand-rolling a shadow catalogue, in two places, badly.** Both `recording_cues` and `mixtape_tracks` carry `artists_text` / `title_text` columns. From the schema, verbatim: _"`finding_id` is NULL for a played track that is not a Fluncle finding; `artists_text`/`title_text` snapshot the identity so a non-finding cue survives."_ **Every track Fluncle has played in a DJ set but never certified is in the database right now as a dead string** — no BPM, no key, no vector, no identity.

Two consequences:

1. **The catalogue retires a hack that already exists.** It is the missing table the schema has been working around.
2. **The crawler's best seed is those tracks** — guaranteed in-genre, vetted by his ear, already mix-tested in a real set (§5.2).

⚠️ **But heed the brand panel:** a track Fluncle _played to a room_ is **not** "a light he never visited." Filing it as cold catalogue is a category error. **A track in a published mixtape is promotion-eligible by definition** and lands in the operator's queue pre-flagged (§6). It is a finding waiting for a coordinate.

**Goals, honestly calibrated:**

- **In reach, highest confidence:** a discovery engine that raises the operator's find-rate. One extra banger pays for the build.
- **In reach:** a `/mix` whose sonic term actually works, and artist/label pages that are substantial.
- **In reach, and the REAL moat — the draft got this wrong (§11.1):** **Spotify killed `audio-features` / `audio-analysis` on 2024-11-27 and has shipped no replacement 19 months on.** Tunebat's key/BPM — 70M pages — are _still_ sourced from that dead API. **Nobody on the open web holds live, first-party-measured BPM/key for drum & bass. Fluncle would.** That is the citable, defensible asset: **the measurement**, not the row.
- **NOT in our control:** whether Google indexes any page; whether an LLM cites us. AI-citation research is unambiguous that engines cite _prose making a claim_, not database rows.

**The thing we are protecting.** `llms.txt` currently asserts, truthfully: _"Every track in the archive is one he found, listened to, and certified."_ If a visitor — or an LLM — cannot tell a finding from a catalogue row, the certification is worth nothing. **Brand dilution is the top risk, and §7 makes every mitigation mechanical.**

---

## 2. Unit 0 — Wake the engine (ships first, needs no catalogue)

**This is the critical path, and it is not in the original brief.** It is a bug hunt and a calibration, not a build, and it delivers value at n=60.

1. ~~**Diagnose why 57/60 findings have no vector.**~~ **DONE / MOOT (see the correction in §0):** all 60 findings are embedded, the cron drained on 2026-07-10, and the sonic term is live. Nothing to diagnose. **The remaining items in this unit are live production bug fixes, and they are now urgent precisely BECAUSE the term is switched on.**
2. **Fix BUG 1 — present-term renormalization inverts the ranking.** `scoreMix` renormalizes over _present_ terms, so a track with **no key and no BPM** but a strong embedding scores `(0.35 × 1.0) / 0.35 = 1.00`, beating a _perfect_ finding at 0.895. **The data-poor row wins.** **Fix `scoreMix` directly: require `denominator >= MIX_WEIGHTS.key` (a key is mandatory to be rankable), else `score: null, flagged: true`.**
   > ⚠️ **A correction to my own draft: I claimed the two-lane design "avoids" BUG 1. It does not.** BUG 1 is a **coverage-heterogeneity** bug, not a cross-pool bug — _inside_ Lane B, an unkeyed-but-embedded catalogue row still beats a fully-scored one. **Two lanes fix nothing here. Fix the scorer.**
3. **Fix BUG 2 — bootstrap `SONIC_CALIBRATION` from the real distribution.** `{ lo: 0.5, hi: 0.95 }` is marked PROVISIONAL in-source and goes live the instant the gate opens. 60 real vectors give 1,770 real pairs — **far better than 10,000 synthetic ones.** Add a `SONIC_CALIBRATION_VERSION` guard.
   > ⚠️ **And it is worse than the draft said: the gate keys off the CANDIDATE POOL, not the archive.** `getMixableTracks` computes `embeddedCount` from _the rows that one query returned_. So the moment Lane B retrieves ~500 embedded catalogue rows, the 0.35-weight sonic term goes live **on a per-request basis**. **The gate must read a stored corpus statistic, never a per-query count.**
4. **Fix BUG 3 — score saturation.** The key term has 14 discrete values; BPM is near-constant in the folded 170–175 band. Ties are broken by `featureDistance`, which the source itself calls _"UNVALIDATED as a similarity metric… a tiebreak ONLY."_ The sonic term is the only continuous discriminator — which is why (2) and (3) must land first.
5. **Fix the two live scan bugs:** `getSimilarFindings`' unbounded candidate scan and `getRandomTrack`'s `order by random()` full-table scan. **These power shipped surfaces and are mis-filed in the draft as catalogue prerequisites.**

**THE PAYOFF, AND THE REAL GO/NO-GO:** with 60 vectors you can finally answer the question the entire 100k bet rests on and **nobody has ever tested** —

> **Is MuQ cosine actually good at separating liquid from neuro? Does "more like this" return tracks that sound alike?**

Judge it by ear on 60 findings. **If MuQ is the wrong space, the catalogue is worthless — and you learned it in an afternoon instead of after a GPU burst and a 1 TB download.**

---

## 3. Unit 1 — The catalogue-free wins (ship this week)

Three things the draft mis-filed as catalogue work. **They need zero catalogue rows.**

- **`labels` table + `/label/<slug>` for the existing findings (§4.4).** `tracks.label` is dirty free text **today** — 34 distinct values over 56 rows, including `Pilot.`, `R.O.A.M`, `spiration music`, and `1991`. That is a live data bug. Normalizing it yields ~40 internal-link hubs.
- **De-template the artist page.** `artistSignatureLine` currently renders _"I first crossed {name}'s path on {when}. Just the one so far. Play it loud."_ — **byte-identical across all 51 one-finding artists** except the name and date. Same for the meta description. This is a self-inflicted thin-content wound regardless of the catalogue.
- **The artist index gate** — see §8.2. **Do not simply drop it 3 → 1.**

---

## 4. Unit A — The two-tier data model

### 4.1 A separate `catalogue_tracks` table

**Rejected — a `tier` column on `tracks`.** Three honest arguments (the panel struck down a fourth — see below):

- **It would enqueue 100k rows into every agent queue on insert.** `enrichment_status` / `capture_status` are `notNull().default("pending")`, and `publishTrack`'s insert never names them (the DDL default is load-bearing _by design_). A bulk insert instantly queues 100k Firecrawl fetches, 100k `claude -p` note calls, and **100k Cartesia TTS renders.** The first sign would be the invoice.
- **It would leak into every public surface.** `listTracks` — the central read builder feeding the homepage, `/api/v1/tracks`, the feeds, `llms-full.txt`, MCP, and the Galaxy star field — **has no tier predicate at all.** There are **76 raw-SQL statements touching `tracks` across 24 files**, and not one carries a tier predicate.
- **`tracks` has 74 columns, ~50 of them finding machinery** — 100k rows × 50 NULLs in the hottest table.

> **A claim my draft made that the panel correctly struck down.** I argued a `tier` column would make it _"permanently impossible to certify that track"_ because `publishTrack` throws `duplicate` on an existing `track_id`. **That is question-begging** — you would simply change the existing-row branch to _upgrade_ instead of throw (~10 lines), and promotion would then be atomic in one row instead of a cross-table stamp with a transactional hole. The separate table is still right, but **not for that reason.**

**Rejected — `log_id IS NULL` as the discriminator.** It is _already_ a real state: a straggler finding awaiting a coordinate backfill. `updateTrack(id, { logId: "auto" })` would happily **mint a permanent coordinate onto a catalogue row.**

**Chosen — a separate table.** But **"zero blast radius by construction" is false**, and pretending otherwise would mislead a builder. The separate table still costs: the `FeedItem` discriminant (I6), the bm25 non-comparability (§9), the labels join, a whole new write API (§4.2), and **the tier-coverage test itself — which must statically parse ~76 raw-SQL sites, a non-trivial piece of engineering this RFC would otherwise bill as free.**

> **⚠️ NAME COLLISION, fix before a builder writes one import:** `track-match.ts` **already exports `type CatalogueTrack`** — and it means **a finding**. That legacy name is now actively wrong (it predates the word being claimed for this tier). **Rename the existing type** (it is internal to one module) and take `catalogue_tracks` / `CatalogueTrack` for the new tier.

```ts
export const catalogueTracks = sqliteTable(
  "catalogue_tracks",
  {
    // IDENTITY. MBID/ISRC is the spine, NOT Spotify — Spotify removed batch track-fetch in
    // Feb 2026, cut search limit 50→10, and briefly DELETED the ISRC field. A row with no
    // Spotify match is still a valid catalogue row.
    id: text("id").primaryKey(), // deterministic content hash (§4.2)
    isrc: text("isrc"), // unique; NULLs distinct in SQLite
    mbid: text("mbid"),
    discogsReleaseId: integer("discogs_release_id"),
    spotifyId: text("spotify_id"), // NULLABLE, an anchor, never the identity
    matchKey: text("match_key").notNull(),
    // GRADE — deliberately NOT called "tier" ("tier" already means finding-vs-catalogue).
    // The honest answer to "10-30% of rows will have no obtainable audio" (§5.4):
    // 'metadata' is a first-class product state, NOT an error — a real catalogue entry with
    // NO bpm/key/embedding, costing ZERO analyze and ZERO embed seconds. 'measured' means
    // Fluncle's own DSP read the audio, and it is EXACTLY the predicate that earns a page (§8.1).
    grade: text("grade", { enum: ["measured", "metadata"] })
      .notNull()
      .default("metadata"),
    analysisStatus: text("analysis_status", {
      enum: ["pending", "processing", "done", "failed", "unavailable"],
    })
      .notNull()
      .default("pending"),
    // MEASUREMENTS — the asset (§1). Provenance is load-bearing: a page is earned only by
    // a value MEASURED from audio, never a scraped tag (§8.1).
    bpm: real("bpm"),
    key: text("key"),
    camelot: text("camelot"),
    bpmSource: text("bpm_source"),
    keySource: text("key_source"),
    analyzedFrom: text("analyzed_from", { enum: ["preview", "full"] }),
    embedding: float32Array("embedding", { dimensions: 1024 }), // NOT json (§9)
    featuresJson: text("features_json"),
    // CONTENT
    title: text("title").notNull(),
    artistsJson: text("artists_json").notNull(),
    artistsFlat: text("artists_flat").notNull(), // denormalized for FTS5 external-content
    labelId: text("label_id"),
    releaseDate: text("release_date"),
    durationMs: integer("duration_ms"),
    previewUrl: text("preview_url"),
    albumImageUrl: text("album_image_url"),
    sourceAudioKey: text("source_audio_key"), // THE SEAM (§5.3)
    // "crawled", never "added". `added_at` on a finding means WHEN FLUNCLE FOUND IT — a
    // Fluncle act, the axis the product sorts on. A catalogue row must never borrow the word.
    crawledAt: text("crawled_at").notNull(),
    promotedTrackId: text("promoted_track_id"), // unique; set once, on promotion
    source: text("source").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("catalogue_isrc_idx").on(t.isrc),
    uniqueIndex("catalogue_promoted_idx").on(t.promotedTrackId),
    index("catalogue_match_key_idx").on(t.matchKey),
    index("catalogue_camelot_bpm_idx").on(t.camelot, t.bpm),
    index("catalogue_analysis_status_idx").on(t.analysisStatus),
    index("catalogue_label_idx").on(t.labelId),
  ],
);
```

**There is no `enrichment_status` / `capture_status` / `context_status` here.** That is the point: **no `listTracks` queue filter can ever reach a catalogue row.** The enrich, capture, context, note, and observe crons are structurally blind to it.

### 4.2 Unit A0 — the three artifacts a builder is BLOCKED on (none were in the draft)

1. **The `FeedItem` discriminant** (I6). A breaking DTO change, and a **prerequisite** to the RFC's own safety guarantee. Do it first.
2. **A catalogue write API — the catalogue has none, so the burst worker literally cannot write its result back.** It _cannot_ reuse `update_track`, because invariant I2 depends on `updateTrack` 404-ing on any id not in `tracks`. Specify **`update_catalogue_track` → `PATCH /catalogue/tracks/:id` (AGENT tier)** plus **`list_catalogue_analysis_queue`** (the worklist read). Both must satisfy the three build-fail tests (`orpc-coverage`, `orpc-auth-coverage`, `orpc-naming`). **This is Unit A scope, not Unit C.**
3. **The `labels` entity + a committed alias map** (§4.5).

### 4.3 `analysis_status` is not a state machine yet — copy the three things the findings pipeline already solved

- **No stale-processing reaper ⇒ a crashed burst worker leaves rows in `processing` forever.** Mirror the shipped `"queue"` meta-filter verbatim: `pending ∪ failed ∪ (processing AND updated_at < now - ENRICH_STALE_PROCESSING_MS)` (30 min).
- **No failure/backoff state ⇒ a permanently-failing track re-enters the queue every tick, forever.** `tracks` carries `source_audio_failures` + `source_audio_attempted_at` + `CAPTURE_MAX_FAILURES = 8`. Add `analysis_attempts` / `analysis_failures` / `analysis_attempted_at`. _(The frontier's counters model **discovery**, not **analysis** — they are not a substitute.)_
- **One column cannot model two steps.** DSP analyze and MuQ embed are separate pipelines running at **different rates** (`enrich-sweep` 4/5min; `embed-sweep` 1/5min) with separate queues. A single `analysis_status` cannot express _"analyzed, not embedded."_ **Either split it, or keep `embedding IS NULL` as the embed queue exactly as today.**

### 4.4 Identity, dedupe, promotion

**Reuse `track-match.ts` verbatim** (the already-tested Rekordbox-sync matcher). Its critical property: **a REMIX / VIP / edit is a DIFFERENT recording**, with neutral descriptors folding back to the original. `analyze-track.ts`'s `versionMatches()` exists precisely because the repo _already got burned_ letting a remix's BPM be computed from the original. **A remix is a distinct row, never a duplicate.**

**⚠️ The duplication bomb the draft missed.** Discogs has **180,148 DnB-style releases** but only **31,667 masters** — a **5.7:1 ratio**. The 1995 12", the 1998 comp cut, the 2011 remaster, and the 2019 reissue are the same recording. With sparse ISRC on 90s vinyl, `matchKey` (which returns `null` on ambiguity rather than guessing) **will not catch them** — and **the `/mix` rail will show the same tune four times.**

**Fix: crawl from Discogs _masters_, not releases**, and make the row id a deterministic content hash `sha256(normalize(artist) | normalize(title) | version-token)` so re-ingesting a dump is an idempotent no-op. Add a near-duplicate merge sweep to the maintenance model (§10).

**⚠️ The dedupe as drafted is NOT race-safe, and the RFC simultaneously proposes a fleet of parallel workers.** "Read, check, then insert" is a TOCTOU: two workers crawling from different labels hit the same track, both read "no match," both insert. **Four fixes, all required:**

1. **The conductor is the ONLY inserter.** One serialized process mints identity. Burst workers **never** insert — they receive `{id, sourceAudioKey}` and only ever `UPDATE … WHERE id = ?` (idempotent, PK-keyed, no identity logic). _This eliminates the race by construction rather than by locking, and it is the same shape as `render-conductor.sh`._
2. **Make idempotence a CONSTRAINT, not a convention:** `UNIQUE(source, source_external_id)` + `ON CONFLICT DO NOTHING`. Re-crawling the same MusicBrainz recording is then free **regardless of ISRC** — which the ISRC-only path does not give you, since most crawled rows won't have one.
3. **The cross-tier stamp is not transactional.** `publishTrack` inserts into `tracks`, _then_ stamps the catalogue row — and a concurrent crawler can insert the row it was about to stamp in between. Put the insert + stamp in **one `db.batch([...], "write")`** (libSQL's implicit write transaction).
4. **A nightly reconcile sweep** stamps `promoted_track_id` on any catalogue row whose ISRC or `matchKey` now names a finding, and surfaces `match_key` collisions to an operator dedupe queue. This makes the residual race **eventually consistent** rather than a correctness hole.

**Promotion.** `publishTrack` is the one canonical birth path — it mints the coordinate and does the full fan-out (playlist, Telegram, Last.fm, Bluesky, IndexNow). **A `tier` flip could do none of that, and a bug could perform it.**

> **v1 ships the DIG without a new spine-touching op.** The staff engineer is right that `promote_catalogue_track` is the one operation that can corrupt the spine, and that at 60 findings the operator already promotes a track by pasting a Spotify URL in seconds. **So `/admin/catalogue`'s promote button simply deep-links to the existing publish flow with the Spotify URL prefilled.** Zero new spine surface, all of the product value. Add the real `promote_catalogue_track` op only once the reconcile sweep (4) is proven.

### 4.5 `labels` — and the honest admission that it is not fully automatable

`Pilot.` vs `Pilot`, `spiration music` (a truncation of _Inspiration Music_), `1991` (a label named like a year), `R.O.A.M` — **no normalizer gets these right.** Fold + edit-distance _proposes_; a human _confirms_. Say so, rather than implying a script solves it.

- **Schema** (plain `db:generate` — drizzle expresses all of it): `labels` (`id`, `slug` UNIQUE, `name`, `sameAsJson`); `tracks.label_id` nullable FK — **keep `tracks.label` as the raw captured string forever** (it is the audit trail and the re-normalization input); `catalogue_tracks.label_raw` + `label_id`.
- **The alias map is CODE, not data.** Commit `label-aliases.ts` — a `Record<foldedRaw, canonicalName>`: reviewable in a PR, unit-testable, diffable. Generate the _candidate_ clusters mechanically (reuse `fold()` from `track-match.ts`; cluster by Levenshtein ≤ 2 or prefix containment); the operator confirms **once**; the confirmed map is the committed artifact.
- **Slug collisions:** `slugify(name)`, `slug` UNIQUE, collision ⇒ append a disambiguator at insert. Never silently reuse.
- **Backfill the 60 findings** via the existing `db:backfill` step (`deploy:cf` already runs `db:migrate && db:backfill && wrangler deploy`).
- **The crawler must NEVER auto-create a label.** It writes `label_raw` and leaves `label_id NULL`. Unmapped strings accumulate in an operator queue at `/admin/labels` — **which is the SAME queue as the §5.2 label allowlist.** My draft invented two queues for one job. **Merge them.** Consequence: `/label/<slug>` only ever shows curated names, and the index gate operates over a clean entity.

### 4.6 The protection — and the test that makes it permanent

**The panel's central catch: my firewalls were row-scoped; every dilution vector is page-scoped.**

The artist page's masthead reads **"Fluncle's Findings"**; its signature line says _"I've logged {n} of their tunes"_; its meta says _"Every {name} banger Fluncle has found."_ Put 1 finding and 400 catalogue rows under that chrome and **the page lies — while every row-level firewall passes.** An LLM summarising that SSR HTML would say Fluncle's archive holds 400+ Nu:Tone tracks, and it would be reading the page correctly.

| #      | Invariant                                                                                                                                                                                                                                                                    | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1     | No catalogue track carries a Log ID                                                                                                                                                                                                                                          | no column; `resolveLogId`'s `isTaken` only queries `tracks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| I2     | No galaxy/video/note/observation/Telegram ever attaches                                                                                                                                                                                                                      | those columns do not exist; `updateTrack` 404s on a non-`tracks` id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I3     | A catalogue insert never collides with a finding                                                                                                                                                                                                                             | §4.2 guards + `UNIQUE(promoted_track_id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| I4     | The agent tier cannot mint a coordinate or write a note/video                                                                                                                                                                                                                | **already true** — `OPERATOR_ONLY_FIELDS = ["isrc","logId","note","videoUrl"]`. Preserve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| I5     | No catalogue row enters any agent queue                                                                                                                                                                                                                                      | the queue columns do not exist on the table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **I6** | Public DTOs never silently carry a catalogue item                                                                                                                                                                                                                            | ⚠️ **FALSE TODAY — this is a PREREQUISITE, not a guarantee.** `FeedItem` is a plain `z.union`, `type` is `z.literal("finding").optional()`, and consumers narrow with `track.type === "mixtape"` / `!== "mixtape"`. **A third arm lands in the `!== "mixtape"` branch and renders as a finding.** This is the single most brand-dangerous bug the RFC could ship. **Fix first (Unit A0): make `type` required, convert to `z.discriminatedUnion("type", …)`, add an exhaustive `switch` + `never` guard at every consumer.** It is a breaking DTO change and it is a _prerequisite_ to the RFC's own headline safety claim. |
| **I7** | **PAGE-LEVEL: any page rendering catalogue rows may not carry the "Fluncle's Findings" nameplate, a first-person Fluncle line, or a `<meta>`/JSON-LD claim that counts or characterises those rows, unless the tier is disambiguated above the fold AND in the meta string** | **the extended coverage test**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| I8     | `musicGroupJsonLd`'s `track` ItemList contains **findings only**                                                                                                                                                                                                             | test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| I9     | Certification vocabulary (`banger`, `finding`, `found`, `certified`, **and the synonyms Fluncle actually uses: `tunes`, `logged`, `dig`**) never characterises a catalogue row                                                                                               | the copy test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| I10    | **Eclipse Gold never appears on a catalogue row _as certification light_** — no Gold Veil hover, no gold coordinate, no gold heat. **The Eclipse Gold FOCUS RING stays**, because focus is an accessibility affordance, not a claim about the music                          | CSS review + a focus-visible assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> **I10 is a correction the panel caught: DESIGN.md makes Eclipse Gold "the focus ring."** Banning gold outright on a 400-row list of links would have been a **WCAG 2.4.7/2.4.11 regression on the largest interactive surface in the product.**

**The load-bearing artifact — `tracks-tier-coverage.test.ts` (build-fail).** Model it on the shipped `orpc-coverage` / `orpc-auth-coverage` / `orpc-naming` family. It scans every `.ts` for SQL touching `tracks` or `catalogue_tracks` and asserts each site is provably single-tier or on a commented allowlist — **and it extends to the page level (I7/I8/I9).** It runs inside `deploy:gate`, so **a tier leak cannot reach production.**

---

## 5. Unit C — Ingest

### 5.1 THE BIGGEST OPEN DECISION: embed from the preview, not the full song

**The panel's sharpest cut, and it dissolves four problems at once.**

The full-audio discipline is **correct for the certified 60**, where quality is the point. It is arguably **wrong for a 100k crate**, where _retrieval_ is the point ("which crate am I digging in?"). A 30 s MuQ forward is **1 window, not ~10.**

|                    | Full-song catalogue                              | Preview-grade catalogue                                         |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| Audio acquisition  | ~500 GB, gray-area, private layer, the §5.3 seam | **already shipped** (`/api/preview`, Deezer/iTunes) — **legal** |
| MuQ compute (100k) | **~4,600 box-hours → needs rented GPU**          | **~460 box-hours → days on rave-02, no GPU**                    |
| R2 storage         | ~$7.50/mo + 500 GB                               | ~0                                                              |
| Legal posture      | the D6 gray area                                 | **clean**                                                       |

> ⛔ **SUPERSEDED BY THE OPERATOR'S RULING (2026-07-11) — see D1 in §13. Preview-grade embedding is REJECTED on quality grounds and is not to be re-proposed.** The reasoning below is preserved only as the record of an argument that was heard and rejected: a 30s preview is often all intro, so its vector describes the intro rather than the track, and half the catalogue would carry garbage. Full audio or no embedding at all.

**It costs one cheap spike, and it is the FIRST spike to run:** _do preview-grade MuQ vectors retrieve the same neighbours as full-song ones?_ Test on findings that have both. **Accept if median cosine(full, preview) ≥ 0.9 and top-10 k-NN overlap ≥ 0.8.**

> **RESOLVED: the operator considered the cheaper path and REJECTED it (2026-07-11). Full audio is the ratified source for all analysis and embedding. See D1 in §13.**

### 5.2 Discovery: a dump join, not a crawl

**Both load-bearing sources publish CC0 bulk dumps. Crawling their APIs at 100k would be antisocial and slow** (MusicBrainz is 1 req/s → 28 h minimum; Discogs is 60/min **and its API ToU forbids persisting Content**, while the **dump is CC0 with no such clause**).

| Source                                                                                                                 | Role                                                                                             | Licence |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| **Discogs monthly dump** — `style_exact=Drum n Bass` (180,148 releases / **31,667 masters**), `Jungle` (9,204 masters) | **the genre gate + the scale**                                                                   | **CC0** |
| **MusicBrainz `mbdump`** (core)                                                                                        | **identity** — ISRC/MBID + Discogs-URL relationships make this a **key join, not a fuzzy match** | **CC0** |
| AcousticBrainz (frozen, API live)                                                                                      | a free BPM/key prior by MBID                                                                     | CC0     |

**Three licence/ToS rails, all load-bearing:**

- **`mbdump-derived` (where MB's tags/genres live) is CC BY-NC-SA — non-commercial.** Do **not** use it for the gate. Use Discogs styles (CC0). _(MB's DnB tag layer is only ~16–18k recordings anyway — far too sparse to be the filter.)_
- **Beatport is disqualified outright.** Its ToS (2026-06-11) §F prohibits using Content _"for the purpose of training, developing or enhancing… machine learning models."_ MuQ embedding is exactly that. **Do not build on Beatport.**
- **YouTube data may not be stored > 30 days.** Usable as a discovery _feed_, never a catalogue of record.

**Seeds, in priority order:**

1. **Fluncle's own played-but-uncertified tracks** — the `artists_text`/`title_text` snapshots in `recording_cues` + `mixtape_tracks` (§1). Guaranteed in-genre, vetted by his ear, already mix-tested. **The highest-signal seeds in existence, and they cost nothing to harvest.**
2. The label allowlist — **⚠️ but `tracks.label` is a POISONED seed set.** Of the 39 distinct values, **~8 are not DnB labels at all** (Anjunabeats, Armada, Axtone, Positiva, Zerothree, Tomorrowland Music, Atlantic UK, Counter) — trance/house/major imprints a single crossover landed on. **A one-time 39-row operator tick is the cheapest quality gate in the whole design.**
3. The artists on existing findings.

**Hops (max depth 3).** label → releases → artists → their other labels. **The drift stop is a ratio, not just a depth cap: a new label joins the allowlist only if ≥70% of its already-classified releases (min n=10) scored DnB.** Anjunabeats gets one DnB single in, fails the ratio, and **never becomes a seed.**

**The gate — 2 of 3 cheap, then 2 expensive:**

1. Discogs style ∈ {`Drum n Bass`, `Jungle`}. _(Verified: Neurofunk/Liquid/Jump Up are **not** Discogs styles.)_
2. Label on the (operator-approved or ≥70%-learned) allowlist.
3. Artist already has a gate-passed track.
4. **BPM band 160–185 after harmonic folding** — free, the analysis runs anyway. A 128 BPM house record **cannot** fold into that band.
5. **Embedding outlier → quarantine, not auto-reject.** A genuinely new subgenre and a mistake look identical to a machine; that is an operator call.

Plus a **sanity sample**: every 1,000 promotions, 20 random rows to `/admin` for a 60-second ear-check; >2 non-DnB trips a kill-switch in the existing `settings` table.

**The frontier table** (`archive_candidates`) reuses the shipped `backfill_*` reliability convention verbatim (`attemptedAt` / `attempts` / `failures` / `doneAt` + exponential backoff), with a `parentId` edge so a bad node's **subtree can be pruned**, and a `gateSignals` JSON so a rule can be **re-run rather than re-crawled**. Stale reclaim (`resolving AND attemptedAt < now-15min → frontier`) mirrors the shipped `enrichment_status` staleness pattern. **Use the shipped circuit breaker** — a 429/503 stops the run with no cooldown so the next tick retries fresh. _Do not invent a second one._

**⚠️ Spotify is no longer the identity spine.** Its Feb-2026 changelog **removed `Get Several Tracks` (no more batching)**, cut `/search` limit 50 → 10, and **briefly deleted `external_ids` (the ISRC carrier)** before reverting. Each candidate now costs ≥2 unbatchable requests. **The primary key is MBID/ISRC (CC0, dump-derived, permanent); Spotify is an optional anchor.**

### 5.3 The private-acquisition seam (the boundary this document does not cross)

**This is a public repository.** The acquisition layer — how full audio is obtained — lives in a **private repo / box-only** and is deliberately **not described, named, scripted, or linked here.** The interface is already shipped and already general:

> **The contract:** a captured full song appears in the **private R2 bucket** under a key; the row's capture state records the outcome; **analysis and embed consume that key and never know or care how the bytes were obtained.** The catalogue's only job is to create rows in the pending state — the private layer's queue then fills itself.

`analyze-track.ts --audio-file <path>` and `embed-sweep.ts`'s source chooser are **already entirely source-agnostic.** Nothing about how the bytes are obtained belongs in this repo. **This seam is REQUIRED — D1 ratified full audio, so the private acquisition layer is load-bearing, not optional.**

### 5.4 No obtainable audio is a PRODUCT STATE, not an error

At 100k — obscure 1996 white-label jungle, deleted uploads, region locks — **10–30% of rows will have no obtainable audio.** So `grade: 'metadata'` is first-class: a real entry (title/artist/label/cat-no/year/ISRC/MBID) with **no BPM, no key, no embedding, no "more like this"** — and it costs **zero** analyze and **zero** embed seconds.

**Never terminal.** Replace a hard `unmatched` with a **decaying retry** (30 d → 90 d → 365 d). A track missing today may be up next year; a permanently-terminal state silently caps the archive's completeness forever and **nobody would ever notice.**

### 5.5 Capacity — and the constraint the draft named wrong

**Measured box facts (rave-02):** 4 vCPU shared, **no GPU**, 7.6 GiB RAM, 150 GB disk (109 free), **21 timers already scheduled**.

**Measured pipeline facts:** MuQ-large ≈ 300M params, CPU torch, **~16 s per 30 s window** (spike-verified on the box), ~2.5 GiB peak RSS, and it **already saturates all 4 threads** — so **concurrency on rave-02 is 1. There is no parallelism to harvest.**

| Step                                   | per track      | × 100k                                                                      |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| DSP analyze                            | ~3 s CPU       | ~83 box-hours                                                               |
| **MuQ embed (full song, ~10 windows)** | **~165 s CPU** | **~4,583 box-hours**                                                        |
| **TOTAL**                              | ~168 s         | **~4,666 box-hours ≈ 194 days saturated / 347 days at the shipped cadence** |

**Three ways out, ranked:**

1. **Preview-grade embedding (§5.1) — 1 window not 10 → ~460 box-hours → days on the box, no GPU, no legal risk.** _The recommendation._
2. **Strided windows — FREE, TODAY, an env var.** `embed-track.py` already exposes `MUQ_HOP_SECONDS`. Setting it to 90 takes a 5-min song from 10 forwards to **4** → **2.5×**. DnB is highly repetitive. **Calibrate first** (median cosine ≥ 0.98, k-NN overlap ≥ 0.8 vs full) — _an afternoon's work for a free 2.5×._
3. **A rented GPU burst: ~110 GPU-hours ≈ $19–76, about 2 days.** _(A bigger Hetzner box is **refuted**: CCX43 at €276/mo → ~55 days → **15× the cost of the GPU for a worse result.**)_

**⚠️ THE DRAFT NAMED THE WRONG BINDING CONSTRAINT.** Compute is $30 — a rounding error you can simply _buy_. **The real long pole is CAPTURE:** ~1,000–2,000 tracks/day through the private layer ⇒ **50–100 days.** **Size the acquisition layer's concurrency to the target, because that is what the calendar actually is.** _(And under §5.1's preview path, capture largely disappears too.)_

**Where it runs.** Dump ingest (10.4 GB Discogs + 7 GB MB, ~60–100 GB expanded) runs **on the operator's Mac, one-off** — _never_ on rave-02, which has 109 GB free and a documented disk-fill history. Frontier resolve runs **Worker-paced by an on-box timer** (the shipped `fluncle-backfill` pattern verbatim: the box holds no vendor keys). Steady-state embed (5–20/day = **4% duty**) stays on rave-02 forever.

**The burst conductor** reuses the `render-conductor.sh` **pattern** (wake → work → park, single-flight, `/status` row, cost ledger) — _but not the rave-03 box_, which is a CPU box already occupied ~85 min per video render. **The box conducts; it does not compute.**

**Disk is stage-and-delete, never accumulate** (the shipped sweeps already `rmSync` in a `finally`). Add four rails, because 100k ticks will find every leak 60 tracks never did: **`PrivateTmp=true`** on the units (a SIGKILL **skips the `finally`** and orphans the temp dir), a **pre-flight disk guard** (free < 5 GB ⇒ no-op the tick), a **janitor**, and a **`Content-Length` size guard** (reject > 50 MB — a mis-captured DJ set).

---

## 6. Unit 3 — The operator's dig (the missed product)

**The draft shipped `promote_catalogue_track` and never gave it a surface.** The panel is right that this is the highest-confidence value in the entire RFC, and the repo **already has the shape shipped**: the submissions queue + the `fluncle-triage` agent writing an advisory verdict _"so it lands in the `/admin` attention queue already assessed."_

**`/admin/catalogue` — the operator's crate dig.** Rank the catalogue by _"closest in sound to your findings, not yet logged."_ One button: **promote** (which calls `publishTrack`, the canonical birth path). Pre-flag every track from a published mixtape as promotion-eligible (§1).

**Rank the crawler's frontier by proximity to Fluncle's embedded findings**, so the _first_ 10k rows crawled are the 10k likeliest to hold a banger. The value curve is brutally front-loaded; the `priority` column is what harvests it.

**The success metric is the only one that matters: does Maurice's find-rate go up?** One banger he would otherwise have missed pays for the build. **Zero in 10k rows means 100k will not save it** — learned at 10% of the cost.

---

## 7. Brand: the firewalls, honestly audited

| Firewall                          | Verdict                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Log ID                         | **REAL.** Structural. The best idea in the RFC.                                                                                                                                   |
| No voice columns                  | **REAL** on the write side. Says nothing about page-level bleed → **I7**.                                                                                                         |
| No agent queue                    | **REAL.** Structural.                                                                                                                                                             |
| The tier-coverage build-fail test | **REAL**, and the most valuable artifact — **once extended to pages (I7–I9)**.                                                                                                    |
| No page                           | **A DIAL, NOT A WALL** — and §8.1 now deliberately opens it for _measured_ rows. Stop calling it a firewall.                                                                      |
| No gold                           | **REAL only as "no certification light"** — gold arrives via CSS, not imports, so a grep will pass while the row hovers gold. Enforce in CSS. **And the focus ring stays (I10).** |
| The vocabulary test               | **PARTIAL.** Blind to runtime-composed copy, ARIA, mastheads, `<meta>`, JSON-LD, **and Fluncle's actual synonyms** (`tunes`, `logged`, `dig`). Extend it.                         |
| The teaching sub-label            | **The most important one** — it _teaches_ rather than _withholds_.                                                                                                                |

**Microcopy — the panel failed five of eight of my strings.** The register is VOICE.md's ratified _machine-facing, honestly-plain third-person_, but the _frame_ is Fluncle narrating his own absence:

```
Heading:     Other tracks
Sub-label:   I haven't been to these ones. No coordinate, no note.
Empty:       That's all I've got from this one.
Row aria:    Listen to {Artist — Title} on Spotify      (the shipped convention; keep the artist)
Load more:   Load more                                   (VOICE.md names this as already-correct — do NOT re-invent it)
```

`/mix`: `Who do you rewind?` (**keep — the strongest string in the set**), `From my findings`, `From the catalogue` **+ the sub-line, which is not optional — without it the parallelism implies both lanes are his**, and for the limiter: `You're digging faster than I can. Give it a minute.` _(My draft's "Easy. Give it a minute and dig again." breaks the Mosh Pit Rule — it scolds the user for a limit **we** imposed.)_

**Two canon amendments must land BEFORE any catalogue surface ships** (an RFC does not get to amend canon by assertion):

- **LORE.md** — the unvisited sky + _"Fluncle may narrate his own absence; he may never characterise the track."_
- **DESIGN.md — The Unlit Rule:** _"Eclipse Gold is the certification light. A row Fluncle never certified is never lit by it: no Gold Veil hover, no gold coordinate, no gold heat. It catches the Dust Veil instead, the cold light of a thing seen from a distance. The one exception is the focus ring, which stays Eclipse Gold on every interactive element, because focus is an accessibility affordance and not a claim about the music."_

---

## 8. Surfaces & SEO/GEO

### 8.1 REVERSED: measured catalogue tracks DO get a page

**My draft said no catalogue track gets a page. The SEO panel refuted every pillar of that, with live evidence (§12.2).** The synthesis:

> **A page is earned by a MEASUREMENT, not by a row.**

```
A catalogue track earns /track/<slug> ONLY when:
    analysis_status = 'done'  AND  analyzed_from IS NOT NULL   → BPM + key MEASURED from audio,
                                                                  never a scraped tag
    AND embedding IS NOT NULL AND >= 1 neighbour edge          → a first-party graph edge
```

An **unmeasured** (`grade: 'metadata'`) row genuinely _is_ a Spotify stub and stays page-less — my draft was right about **those**. But a **measured** row carries a first-party DSP measurement and a MuQ "sounds like" graph that **literally no one else on the open web has**, because Spotify's `audio-features` has been dead since 2024-11-27. That is exactly the _"real data differentiation"_ the scaled-content policy's survival clause requires.

**And it coheres with the LORE:** the instrument reading _is_ the content. A telescope does not narrate — **it publishes its data.**

**Ship it OPEN on the 1,000-track pilot** (a safe, reversible, evidence-generating experiment that closes by flipping one constant). _Shipping it closed, as my draft proposed, means learning nothing — and a ratified "no" never gets re-litigated._

### 8.2 REVERSED: the artist gate becomes a substance gate, not `3 → 1`

**My draft's `ARTIST_INDEX_MIN_FINDINGS: 3 → 1` was the actual thin-content risk in the document.** A 1-finding artist page renders one cover and **one byte-identical templated sentence across all 51 such artists** — Google's named March-2026 enforcement pattern, exactly. _(It was also inconsistent with the shipped `GALAXY_INDEX_MIN_FINDINGS = 4`.)_

```ts
// Indexable when the page carries something a crawler cannot get from Spotify:
//   findings >= 3                                                   (today's bar — KEEP)
//   OR (findings >= 1 AND catalogueTracks >= 8 AND measured >= 3)   (substance, not count)
```

This yields the ~59 pages **if and only if the catalogue actually made them substantial** — the change's own stated theory, honestly enforced. Below the gate: unchanged (200 + `noindex, follow` + out of the sitemap). **And de-template `artistSignatureLine` + the meta description regardless (§3).**

### 8.3 The GEO position — REVERSED, and the real moat

**My draft's claim was false.** I asserted every major music DB blocks AI crawlers. **MusicBrainz and Last.fm do not** (verified 2026-07-11) — and **MusicBrainz is CC0 with twice-weekly bulk dumps**, so no lab needs to crawl it. Worse, it was **self-contradicting**: §5.2 sources the catalogue _from those same CC0 dumps_. **You cannot source from the commons and claim a moat on the commons.**

**The real moat is the measurement.** Spotify killed `audio-features`/`audio-analysis` on **2024-11-27** with **no replacement 19 months on**; Tunebat's 70M pages still serve values from that dead API. **Nobody on the open web holds live, first-party-measured BPM/key for drum & bass. Fluncle would.**

**What would actually get Fluncle cited** — and my draft had none of it. AI engines cite **prose that makes a claim** (listicles are ~22% of all AI citations), not database rows. So the GEO play is **claim-bearing prose derived from the measurements**:

- _"The 25 hardest neurofunk rollers at 174 BPM"_ — measured, first-party.
- _"Every Hospital Records release in F minor."_
- _"What actually changed in liquid DnB between 2019 and 2026, measured across the catalogue."_

These cannot be scaled-content-abused because **each makes a real claim on real numbers no competitor has.** Plus a **"how these numbers are measured" methodology page** linked from every BPM/key — the single highest-leverage E-E-A-T + GEO artifact available, and it costs one page.

### 8.4 The rest

- **`/search?q=` is `noindex` + `Disallow: /search`** — _every_ competitor does this (MusicBrainz, Genius, Last.fm, RYM, AllMusic, Bandcamp). **Naming collision, build-failing:** `search_tracks` is **already taken** by the Spotify submit-flow search. New ops: **`search_catalogue`**, **`list_catalogue_tracks`**.
- **Pagination: crawlable SSR'd `?page=N`, not bare infinite scroll.** AI crawlers execute **zero JavaScript** (500M+ GPTBot fetches, confirmed June 2026 for all 8 major agents). My draft's infinite scroll would make rows 25–500 **invisible to exactly the audience it claimed to optimize for.** History API drives the UX on top.
- **Canonical:** self-canonical + Spotify in JSON-LD `sameAs`. **Never** a cross-domain canonical to Spotify.
- **`Dataset` JSON-LD** on the catalogue hub (my draft wrongly said no music-adjacent rich result exists — **`Dataset` is in the 2026-06-15 gallery** and feeds Google Dataset Search). A DnB catalogue with first-party measured BPM/key **is a dataset**.
- **The internal-link layer is mandatory, not optional:** `/labels`, `/label/<slug>`, co-credit artist↔artist links, tempo/key hubs. Register all new surfaces in `@fluncle/registry` (they light up `/status`, llms.txt, the sitemap, the dev-row, the doctrine doc). **`/labels`, `/search`, and `/mix` are all currently missing from the sitemap plan.**
- **Sitemap:** no index split (it stays small). **Wire IndexNow to fire when a page crosses the index gate.**
- **`llms.txt` stays curated — do not scale it** (97% of llms.txt files get zero requests). **And fix the `llms-full.txt` leak** — it calls `listTracks`, which has no tier filter.
- **No album pages** — 56 distinct albums across 56 tracks; a 1:1 duplicate of a track page.

---

## 9. Storage & search

**What breaks today:** the Worker reaches Turso over **HTTP into a 128 MB isolate**, embeddings are **JSON text** (~19–22 KB/row), and `getSimilarFindings` scans **every row with no LIMIT**. At 100k that is **~2 GB of JSON into a 128 MB isolate** — it does not get slow, it **dies** (~4–5k rows). Turso also **bills rows read**, so a 100k scan is 100k billed rows _per request_. **And `cluster-sweep.ts` pages the entire embedded corpus nightly** — 2.27 GB per run at 100k. **`embedding_json` as TEXT does not survive. This is a blocker, not a nice-to-have.**

### THE RISKIEST CHANGE IN THE RFC — and it is not the catalogue

**It is the `tracks.embedding_json` → `F32_BLOB` conversion.** The catalogue is _additive_, and a bad catalogue row is deletable (the coordinate-less superpower). The embedding conversion is the only change that **mutates a live, production-critical column on the hottest table**, whose writer is a **pinned, baked, out-of-band cron on rave-02**, through a pipeline that **migrates before it deploys**.

**The good news the draft missed: the wire format is `number[]` at every boundary, and it does not have to change.** The box writes a bare JSON array via `update_track`; the server does the `JSON.stringify`. **Hold the `number[]` DTO and change only the storage ⇒ NO CLI release, NO box re-bake, NO pinned-CLI dependency** — which matters enormously right now, since CLI releases are blocked on the npm/sigstore break.

**A dual-write window IS still needed**, for a subtler reason: `deploy:cf` runs `db:migrate` **before** `wrangler deploy`, so there is a window where the new column exists and the _old_ Worker is still live, writing only `embedding_json`.

1. `--custom` migration: add the column + backfill `vector32(embedding_json)` + the partial index. **Add the column to `schema.ts` as a drizzle `customType` in the same PR**, or the next `db:generate` emits a `DROP COLUMN`.
2. Deploy N: server writes **both**; reads unchanged.
3. Deploy N+1: reads flip to `vector_top_k`; the embed queue becomes `embedding IS NULL`; a reconciliation `UPDATE … WHERE embedding IS NULL AND embedding_json IS NOT NULL` closes the deploy-window gap.
4. Deploy N+2: drop `embedding_json`.

**The GO design:** `F32_BLOB(1024)` (exactly 4 KB/row — **4.5× smaller than JSON and no parse**) + a **partial DiskANN index** + an **external-content FTS5** table.

```sql
CREATE INDEX catalogue_embedding_idx ON catalogue_tracks (
  libsql_vector_idx(embedding, 'metric=cosine', 'max_neighbors=20', 'compress_neighbors=float1bit')
) WHERE embedding IS NOT NULL;
```

**THE SPIKE IS ALREADY RUN — and it is a GO on size.** The staff-engineer reviewer measured it against the pinned embedded libSQL (2,000 real F32_BLOB rows, extrapolated):

| index config                                         | **→ 100k**     | insert rate  |
| ---------------------------------------------------- | -------------- | ------------ |
| **DEFAULT** DiskANN at D=1024                        | **21.9 GB** ❌ | 40 rows/s    |
| `max_neighbors=20, compress_neighbors=float8`        | 2.98 GB        | 402 rows/s   |
| **`max_neighbors=20, compress_neighbors=float1bit`** | **1.29 GB ✅** | 652 rows/s   |
| `mn=20, float1bit`, **D=256**                        | 0.35 GB        | 1,951 rows/s |

**The tuned index is 1.29 GB at 100k — comfortably under the 4 GB threshold and the 9 GB plan. Storage is not a blocker, and NOTHING in this RFC is gated on it.** _(The default-settings blowup is real and even worse than the community report — so the settings are load-bearing, not tuning.)_

**But the spike as I originally scoped it could not answer the question that matters.** Random synthetic unit vectors in 1024-d are essentially all mutually orthogonal — **there is no neighbourhood structure for an ANN to find or miss**, so recall on synthetic data is a meaningless proxy for recall on clustered real MuQ vectors. And `compress_neighbors=float1bit` (1-bit quantized neighbours!) is _precisely_ the setting whose recall cost only appears on real data.

> **So the spike is re-scoped as a RECALL spike on real MuQ vectors — which by definition runs AFTER the pilot corpus exists.** Size: measured, GO. Recall: pending real vectors. **This is the third independent reason Unit 0 comes first.**

**FTS5 must be external-content (`content='catalogue_tracks'` + triggers)** so the app **never writes to the virtual table** — SQLite's trigger does, server-side.

**⚠️ bm25 is CORPUS-RELATIVE, and this forces the search design.** `bm25()`'s IDF term depends on document frequency **within its own FTS table**. A 60-row findings index and a 100k-row catalogue index produce **ranks that are not comparable — ever.** So:

> **`ORDER BY (tier), rank` — findings first, then catalogue — is not a taste choice. It is a technical NECESSITY.** A blended cross-tier relevance list is permanently off the table under two FTS tables. _(It happens to be the product rule we wanted anyway: depth behind the findings, never noise in front of them.)_

Two knock-ons a builder must know: the ORDER BY needs a **UNION with a synthesized tier discriminant** (`catalogue_tracks` has no `log_id` column, so `ORDER BY (log_id IS NULL)` literally will not compile); and **pagination is sequential per tier** (exhaust findings, then catalogue) — **no cross-tier cursor is needed anywhere.**

_(By contrast, the two **vector** indexes DO merge soundly: cosine distance is absolute within one MuQ space, so over-fetching k from each index and re-ranking the merged set by `vector_distance_cos` gives a globally exact order. The "two indexes = two lanes" claim holds for vectors and fails for text.)_

> **Three traps.** (1) FTS5 `MATCH` is **injectable** — tokenize and rebuild as `"tok" "tok"*`; never interpolate.
> (2) **CORRECTED — my draft's `F32_BLOB` read recipe was itself wrong.** The pinned client's `Value` type is `ArrayBuffer` (hrana explicitly _copies_ `Uint8Array` → `ArrayBuffer` on decode), so `v.buffer` is `undefined` and the "fix" throws. **The correct read is `new Float32Array(v)`.** Note the asymmetry that will trip a builder: the driver **accepts** `Uint8Array` on write but **returns** `ArrayBuffer` on read.
> (3) **libsql#1811 (the FTS5 `batch()` panic) is NOT fully sidestepped by external-content.** `drizzle-kit migrate` itself calls `db.batch(statements)` — so if the bug is live on the remote path it fires **in the Cloudflare build**, on the very migration that creates the FTS index. **Verify against a throwaway Turso Cloud DB before Unit B merges.** _(It did not reproduce on the pinned embedded client.)_

**Migrations must survive THREE engines, not one.** The DDL runs identically on (a) Turso Cloud prod via `deploy:cf`, (b) the per-worktree `turso dev` server, **and (c) the embedded in-memory libSQL in `integration-db.ts`, which applies every generated migration in every integration test — so if the DDL fails there, `deploy:gate` fails and PROD IS BLOCKED.** The reviewer probed (c) live: `F32_BLOB`, the partial `libsql_vector_idx` with both tuning params, `vector32()`, `vector_top_k` + join, `vector_distance_cos`, the FTS5 external-content table, its triggers, `bm25()`, and a `db.batch([...], "write")` firing an FTS trigger — **all pass. Keep that probe as a committed test.**

**Verified live: the pinned drizzle-kit 0.31.10 supports `generate --custom`.** Add a `db:generate:custom` script (it does not exist yet) and **amend AGENTS.md's wording**, or the rule blocks the only viable path:

> _Never hand-create a migration FILE or edit the journal; use `db:generate` for schema diffs and `db:generate:custom` for DDL drizzle cannot express._

**NO-GO fallback (now unlikely to be needed): Cloudflare Vectorize** — under $2/month, loses the SQL join. **The 256-d projection** (0.35 GB, 3× faster inserts) remains the lever if recall allows.

---

## 10. `/mix`, and the maintenance model

**Two lanes with a reserved quota, never a boost.** Findings would be 0.06% of the corpus, so a single blended ranking shows a finding **approximately never**. But a `+0.1 if isFinding` boost **corrupts the one thing the engine claims to be true** (its header: _"NOT an imitation of how Fluncle himself sequences"_) and is **undetectably** corrupting — either it does nothing, or it floods the rail with findings that mix worse than what it hid. **You cannot tune it honestly.**

- **Lane A "From my findings"** — pool = `tracks` (~60 rows; today's query). **Quota: top 3, always shown.** It makes no claim about the catalogue; it answers a _different question_, truthfully, and is always answerable.
- **Lane B "From the catalogue"** — pool = `catalogue_tracks`, via ANN retrieval.

**Taste-seeding: the vector RETRIEVES, mixability RANKS.** Taste vector = normalize(mean of picked artists' centroids), each artist's centroid normalized first so a 400-track artist doesn't drown a 3-track one. Then: **retrieve top-K ≈ 500 by cos(T, v) → rank those 500 with `rankMixable`.** _Not_ a fourth scoring term — a fourth term would let a track win the rail **because you like the artist**, which is what a DJ will not forgive at the moment of a transition. **Taste picks the crate; the engine keeps its promise about the mix.** And it is simultaneously the fix for the 128 MB isolate — **the product answer and the scaling answer are the same mechanism.**

**ONE carrier: `?seed=` in the URL** (artist slugs, cap 10, mirroring the shipped `?set=` codec). Zero backend, shareable, **works logged-out**. _(Cut: a localStorage mirror and a `user_taste_seeds` table — three carriers for ten slugs is ornament, for a surface with one user today.)_

**⚠️ Three blockers the panel found:**

- **Lane B has NO legal audio path.** `/api/preview` resolves via `getTrackByIdOrLogId` — **the `tracks` table only** — and the captured full audio is **explicitly banned as a playback source** by shipped policy. **"Rows you can't hear are dead rows."** Lane B's preview must be a **live Deezer/iTunes resolve by ISRC through a widened relay**, and that is a first-class Unit E deliverable with its own acceptance criterion. _Without it Lane B is a silent list of names._
- **The `?set=` codec is findings-only** (`isLogId`-gated). Putting catalogue tracks in a chain is a 6-file fan-out (codec, `MAX_SET_LENGTH`, hydrate, JSON-LD, OG, and the `exclude` clause — which is `log_id not in (…)` and **cannot exclude a catalogue track**, so they will be re-suggested into a chain that already holds them).
- **Lane B's ranking will be dominated by the field the codebase distrusts most.** `MIX_WEIGHTS.key = 0.50`, and catalogue keys are **DSP-grade by definition** — there is no Rekordbox ground truth and no operator for 100k rows. _(The whole reason `fluncle-rekordbox-sync` exists is that the DSP key estimator is weak.)_ **State this honestly on the surface, or the rail lies.**

**MCP — my draft contradicted itself** (§8.3 nominated MCP as the prize; §9 required it return zero catalogue rows). **Resolution: existing MCP tools stay findings-only; the catalogue gets separate, separately-named tools carrying an explicit tier field and no Log ID.**

**THE MAINTENANCE MODEL — entirely missing from my draft.** A crawler and no janitor is a liability at 100k:

- **Near-duplicate merge** (the 5.7:1 release:master ratio — §4.2).
- **A re-crawl cadence + a staleness column**; a **delete path** (catalogue rows are _disposable_ precisely because they carry no coordinate and no artifacts — that is the quiet superpower of the coordinate-less design).
- **Mirror every ingested dump into R2** (10.4 GB ≈ $0.16/mo). **Juno Download vanished on 2026-06-01 with zero notice** — a live demonstration that a source can evaporate. Cheapest insurance in this document.

---

## 11. Sequencing & ownership

**The naive order (crawl 100k → wire up `/mix`) spends months and real money _before_ learning whether the sonic term works at all. Invert it.**

| Order | Unit                                                                                                                                       | Parallel?                | Notes                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Unit 0 — wake the engine** (§2): drain the 60 embeds, fix BUGs 1–3, calibrate, fix the two live scan bugs                                | —                        | **Zero-decision unblock. An afternoon in the main checkout.** Needs no catalogue, no table, no crawler, no money. **It is also the only thing that can tell you MuQ is the wrong space.** |
| **1** | **Unit 1 — the catalogue-free wins** (§3): `labels`, de-template the artist page, the substance gate                                       | with Unit 0              | Independent. 10× indexable surface with zero catalogue rows.                                                                                                                              |
| **2** | **Unit A0 + A** (§4): the `FeedItem` discriminant → the catalogue table + identity + the write API + **the tier-coverage build-fail test** | after 0                  | A0 is a **prerequisite**, not a nicety.                                                                                                                                                   |
| **3** | **The pilot — 1,000 tracks, seeded from Fluncle's own played-but-uncertified set-list tracks**                                             | —                        | **The gate to everything.** A _product experiment_, not a plumbing test.                                                                                                                  |
| **4** | **The recall spike** on the pilot's real MuQ vectors → lock the index settings                                                             | after pilot              | _(Size is already measured: GO at 1.29 GB.)_                                                                                                                                              |
| **5** | **Unit 3 — `/admin/catalogue`, the operator's dig** (§6)                                                                                   | after pilot              | **The highest-confidence value in the RFC.**                                                                                                                                              |
| **6** | Storage cutover, public surfaces, public `/mix`                                                                                            | after the engine verdict | Only if 0 and 5 succeed.                                                                                                                                                                  |

**The ONE thing that de-risks the most: Unit 0.** It costs an afternoon and it answers the question the entire 100k bet rests on and nobody has ever tested — _does MuQ cosine actually separate liquid from neuro?_ **If the answer is no, everything downstream is worthless, and you learned it for free.**

**The pilot is the second gate:** _do 1,000 embedded catalogue tracks make `/mix` produce mixes the operator actually likes, and does the dig surface a track he'd have missed?_ **If not, do not crawl 100k** — either the calibration is wrong (fixable) or MuQ is the wrong space (a much bigger finding, and far cheaper to learn at 1,000 tracks than at 100,000).

**Nothing is gated on the storage spike.** It has been run.

**Deploy discipline:** each unit is its own PR. A push to `main` auto-deploys; space the merges (Cloudflare coalesces rapid pushes and can drop an intermediate build). **The riskiest single change is the `embedding_json` → `F32_BLOB` cutover** (§9) — it mutates a live column on the hottest table, written by a baked out-of-band cron. Follow the four-deploy ladder.

---

## 12. What the panel overturned (do not re-litigate)

The adversarial panel struck down **six** claims in my draft. Recorded so the reasoning is not lost and the errors are not re-introduced:

1. **The AI-crawler "moat" was FALSE.** MusicBrainz and Last.fm do **not** block AI crawlers, and MusicBrainz is **CC0 with bulk dumps** — and this RFC _sources from those dumps_. You cannot claim a moat on the commons. **The moat is the first-party measurement**, in a world where Spotify's `audio-features` has been dead since Nov 2024. (§8.3)
2. **"No catalogue track pages" was WRONG as a blanket rule.** MusicBrainz's `Disallow: /recording/` is a **server-load posture** (a donation-funded nonprofit on bare metal; Fluncle is on Workers with zero marginal serve cost). Beatport submits **19.9M track URLs, verified 2026-07-11**. Tunebat runs **~750k pageviews/month on 70M stub pages built from a _dead_ API**. **Measured rows get pages; unmeasured rows don't.** (§8.1)
3. **`ARTIST_INDEX_MIN_FINDINGS: 3 → 1` was the actual thin-content risk** — 51 byte-identical templated pages. **It becomes a substance gate.** (§8.2)
4. **Invariant I6 was FALSE** — `FeedItem` is not a discriminated union and `type` is optional, so a catalogue arm would render **as a finding**. The compiler protects nothing today. **Now a prerequisite (Unit A0), not a guarantee.** (§4.5)
5. **The firewalls were ROW-scoped; every dilution vector is PAGE-scoped.** The artist page's masthead, first-person signature line, meta, and `MusicGroup` JSON-LD all frame the whole page as findings. **Now I7–I9.** (§4.5)
6. **The storage spike was NOT the critical path** — it has been run: **1.29 GB at 100k, a GO.** But its recall criterion is **unmeasurable on synthetic vectors** (orthogonal in 1024-d, no neighbourhood structure to miss). **It is re-scoped as a recall spike on real MuQ vectors, which runs AFTER the pilot. Nothing is blocked by it.** (§9)

**Also corrected:** my `F32_BLOB` read recipe was itself wrong (`new Float32Array(v)`, not `v.buffer`); the two-lane design does **not** fix BUG 1; `tracks` has 74 columns and 76 SQL sites (not 60/~40) and does have one unique index; and "zero blast radius by construction" oversells the separate table.

---

## 13. Decisions needed BEFORE handoff

1. ~~**[D1 — THE BIG ONE] Preview-grade or full-song embedding?**~~ **CLOSED — RATIFIED FULL AUDIO (operator, 2026-07-11). Do not re-open.** The operator's ruling, verbatim in substance: a 30s preview is frequently 30 seconds of intro — piano, pads, no drums — so BPM reads wrong, key reads wrong, and the clip carries _no information about what the track actually is_. Embedding that describes an intro, not a roller. At archive scale it yields "at most 50% of the archive with decent valuable information, and the rest is garbage" — and a poisoned embedding space destroys the one asset the entire direction rests on. **This is exactly why the project moved to full-audio capture in the first place; preview-grade is a regression, not a fallback.** The legal posture is settled and is not an agent's to re-argue: the audio is **never shared with anyone, anywhere, ever** — privately gated, analysis-only, acquisition in a private repo / box-only. **If a track's full audio is genuinely unobtainable, the honest outcome is that it gets NO embedding — never a preview-grade one.** (Every "preview-grade dissolves this" aside elsewhere in this document is superseded by this ruling.)
2. **[D2 — ONE-WAY DOOR] The embedding model.** MuQ-large defines the vector space, `get_similar_findings`, and every galaxy centroid. **Re-embedding 100k later is another full burst plus a galaxy reset.** Decide **before** the run. **And Unit 0 must first prove MuQ is even the right space** (§2).
3. **[D3] The real target number.** Discogs holds **~41k deduped DnB+jungle masters**, so **100k ≈ the entire recorded DnB universe**, and its usable (previewable, in-band, embeddable) subset is plausibly **10–30k**. **100k is a hypothesis about embedding density, not a goal.** Recommend committing to **10k first** (§6) and letting the find-rate decide.
4. **[D4] The public name.** "The archive" is **taken** (it means the findings). Confirm **"the catalogue"** — and note it is the _astronomer's_ word (Messier, NGC, Gaia: catalogues of objects **observed from a distance and never visited**), which is exactly right. **Recommend renaming this file to `the-catalogue.md`** and dropping the "THE ARCHIVE" codename — a codename that collides with the term of art is a landmine. Pick one spelling (`catalogue`) and lint it.
5. **[D5] Ratify the two canon amendments** (§7): LORE.md's unvisited sky, and DESIGN.md's Unlit Rule.
6. **[D6] Legal posture — CONFIRMED (2026-07-11).** Acquisition stays private-repo / box-only, and this public RFC's silence on it is the intended boundary. The audio is never shared, served, or exposed — privately gated, analysis-only. **D1 does not moot this: full audio is ratified, so the private seam is required.** Also ratify: **Discogs styles (CC0) for the gate; MB core (CC0) for identity; never `mbdump-derived` (non-commercial); never Beatport (its ToS bars ML/AI use outright).**
7. **[D7] The 39-label operator tick** — ~8 of the current labels are **not DnB** (Anjunabeats, Armada, Axtone…). Five minutes of work; it gates the whole crawl's quality.
8. **[D8] Paid infrastructure** (~$30–80 GPU burst; ~$7.50/mo R2) — per AGENTS.md, needs an explicit yes. _(D1's preview path may remove the GPU line entirely.)_

_(Struck: the draft's "storage branch" decision. **The spike has been run — Turso native is a GO at 1.29 GB.** No decision needed.)_

---

## 14. Acceptance criteria

**Unit 0 (engine)** — 60/60 findings embedded · BUGs 1–3 fixed with tests (**an unkeyed, embedded row cannot outrank a fully-scored finding**) · `SONIC_CALIBRATION` bootstrapped from the real distribution + version-guarded · `getSimilarFindings` and `getRandomTrack` no longer full-scan · **the operator has listened to "more like this" on 10 findings and judged MuQ fit for purpose.**

**Unit 1** — `labels` normalized; `/label/<slug>` live; `artistSignatureLine` + meta de-templated (no two artist pages byte-identical).

**Unit A** — `tracks` untouched but for indexes · **`tracks-tier-coverage.test.ts` FAILS THE BUILD on an unguarded cross-tier query, and covers pages (I7–I9), not just SQL** · inserting 100k rows enqueues **zero** enrich/capture/context/note/observe jobs · **`publishTrack` still succeeds for a Spotify track that already exists as a catalogue row** (the "catalogue eats the finding" regression test) · the feeds, `llms-full.txt`, `/api/v1/tracks`, existing MCP tools, and the Galaxy star field return **zero** catalogue rows · **the copy test catches `tunes`/`logged`/`dig`, not just `banger`/`finding`** · **the Eclipse Gold focus ring still passes an axe/focus-visible check on a catalogue row.**

**Unit 3 (the dig)** — `/admin/catalogue` ranks by proximity-to-findings · promote calls `publishTrack` · a row promotes exactly once · **the operator finds ≥1 promotable track in the first 10k he would otherwise have missed.**

**Ingest** — the 1,000-track pilot completes end to end with a **measured** per-track wall-clock · the gate records a reason for every rejection · rate limits honoured, honest UA · **the box never accumulates audio** · **the public repo contains no acquisition tooling** (secret-hygiene review).

**Surfaces** — every below-gate page is `noindex, follow` **and** absent from the sitemap · **catalogue rows are crawlable without JS (`?page=N`)** · a Lighthouse/CWV gate on a 500-row artist page · IndexNow fires on gate crossing · **a GSC decision rule with a threshold: if ≥60% of artist pages sit in "Crawled – currently not indexed" at 60 days, the gate was wrong — revert.**

**`/mix`** — **Lane B rows are auditionable** (live preview by ISRC) or they do not ship · Lane A always shows 3 findings when 3 exist · taste-seeding works fully logged-out.

---

## 15. Risks

| Risk                                                                                                                                                               | Severity                 | Mitigation                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~**MuQ is the wrong space for mixability** — never tested~~ **ANSWERED (2026-07-11): tested at n=60, it works** — the k=4 fit produced four ear-nameable galaxies | **RETIRED**              | **Already answered before a cent was spent. See the §0 correction.**                                                                                                                                                                                   |
| **Brand dilution** — a visitor or LLM cannot tell a finding from a catalogue row                                                                                   | **HIGHEST**              | I1–I10, incl. the **page-level** I7. The LORE framing. The teaching sub-label. `identity.ts`'s `fluncleDescription` (reused verbatim across meta/llms.txt/JSON-LD/manifest) **must** gain a tier clause.                                               |
| **Legal / ToS** — full-audio acquisition at scale is a genuine gray area                                                                                           | **HIGH, stated plainly** | Operator has accepted it; acquisition stays private-repo/box-only; **D1's preview path would remove it entirely.** Prefer CC0 dumps; honour rate limits; never route around a block. **This RFC does not design acquisition and does not launder it.** |
| **Capture throughput (the real long pole)** — 50–100 days                                                                                                          | high                     | Size the private layer's concurrency to the target. D1 may moot it.                                                                                                                                                                                    |
| **Near-duplicates** — 5.7:1 release:master ratio; the rail shows the same tune 4×                                                                                  | high                     | Crawl masters; content-hash ids; a merge sweep (§10).                                                                                                                                                                                                  |
| **Lane B ranked by DSP-grade keys** at `MIX_WEIGHTS.key = 0.50`, with no ground truth at 100k                                                                      | high                     | State it on the surface. Consider down-weighting key for unverified rows.                                                                                                                                                                              |
| **DiskANN blowup at 1024-d** (43× measured by a third party)                                                                                                       | high                     | The spike gates it; Vectorize pre-authorized; 256-d reduction is the lever.                                                                                                                                                                            |
| **The catalogue eats a future finding**                                                                                                                            | high                     | Separate table + pre-insert guard + a named regression test.                                                                                                                                                                                           |
| **A silent tier leak** into a feed / llms.txt / MCP                                                                                                                | high                     | The build-fail coverage test.                                                                                                                                                                                                                          |
| **Operator attention** — does the catalogue compete with the ~60/yr certification cadence?                                                                         | medium                   | **Unit 3 is designed to make it _feed_ that cadence, not compete with it.** If find-rate doesn't rise, stop.                                                                                                                                           |

---

## Appendix — verifications

**Verified live in the code:** ⚠️ `mixability.ts`'s header claim of `embedding_json` **3/56, "the sonic term is DORMANT"** was **STALE and is now corrected in-source** — all 60 findings are embedded and the term is LIVE (see the §0 correction; this is the one place the draft's source-reading was outrun by reality); `embed-sweep.ts` gates on `source_audio_key IS NOT NULL` and _"NEVER falls back to the preview relay"_; `MIN_EMBEDDED_PAIRS = 50` (⇒ 11 findings needed); `tracks` has **zero secondary indexes**; `trackId` (PK) **is the Spotify id**; `enrichment_status`/`capture_status` default `'pending'` at the DDL; **31 call sites filter `log_id is not null` but `listTracks` does not**; `OPERATOR_ONLY_FIELDS = ["isrc","logId","note","videoUrl"]`; `recordings` is _"deliberately COORDINATE-LESS"_ and `mixtape_clips` carries _"NO Log ID"_; **`recording_cues` + `mixtape_tracks` already fake uncertified tracks with `artists_text`/`title_text`**; `search_tracks` proxies **Spotify**, not the catalog; `ARTIST_INDEX_MIN_FINDINGS = 3`, `GALAXY_INDEX_MIN_FINDINGS = 4`; `robots.txt` carries `Content-Signal: search=yes, ai-input=yes, ai-train=yes`; `llms.txt` asserts _"Every track in the archive is one he found, listened to, and certified"_; `render-conductor.sh` drives a **scale-to-zero** worker; **`drizzle-kit@0.31.10` supports `generate --custom`** (run live); `deploy:gate` runs the full test suite.

**Measured:** rave-02 = 4 vCPU / 7.6 GiB / no GPU / 150 GB (109 free) / 21 timers. MuQ-large ≈ 300M params, **~16 s per 30 s window** on the box, ~2.5 GiB peak RSS, saturates all 4 threads.

**External (fetched 2026-07-11 unless dated):** Google spam policies (2026-05-15), structured-data gallery (2026-06-15, **`Dataset` present; no music types**), crawl-budget guide, AI-features doc; robots.txt of MusicBrainz (**no AI blocks**), Last.fm (**no AI blocks**), Tunebat (**no AI blocks**), Genius/RYM/AllMusic/Bandcamp/Beatport (**AI-blocked**); Beatport sitemap index (**19.9M track URLs, lastmod 2026-07-09**); MusicBrainz CC0 data licence + twice-weekly dumps; Discogs style counts (180,148 DnB releases / **31,667 masters**) + API ToU; Beatport ToS §F (**bars ML/AI use**); Spotify Web API deprecations (2024-11-27) + **Feb-2026 changelog (batch track-fetch removed, search limit 50→10)**; Turso pricing + AI/embeddings docs; libsql#3778 (**43× DiskANN overhead at 1024-d**); libsql#1811 (FTS5 `batch()` panic, open); Cloudflare Workers/D1/Vectorize limits; RunPod GPU pricing; R2 pricing; the llms.txt zero-request study (137k domains); Vercel/MERJ AI-crawler JS telemetry (**zero JS execution**); Juno Download shutdown (2026-06-01).
