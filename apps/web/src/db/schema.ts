import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * libSQL's native fixed-width float32 vector column — `F32_BLOB(1024)`, the storage
 * form `vector32()` produces and `vector_distance_cos()` ranks IN SQL. 4,096 B/row
 * against the 21,804 B a 1024-d vector costs as a JSON array (measured on the prod
 * snapshot), and, far more importantly, it is the ONLY form the database can rank
 * without shipping every vector into the Worker isolate.
 *
 * `1024` must track `EMBEDDING_DIMS` (lib/server/embedding.ts) — inlined rather than
 * imported so this schema stays a leaf module for drizzle-kit.
 *
 * The driver reads a blob cell back as an `ArrayBuffer` (NOT a `Uint8Array`) — see
 * `readEmbeddingBlob` in lib/server/embedding.ts, the one place that decodes one.
 */
const float32Vector = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "F32_BLOB(1024)",
});

/**
 * THE UNIVERSAL MUSIC OBJECT — every track Fluncle knows about, certified or not.
 *
 * `tracks` is the SUPERTYPE half of the supertype/subtype pair it forms with `findings`
 * (below). It carries only what is true of a RECORDING, independent of whether Fluncle
 * ever certified it: identity (`track_id`, `isrc`, the Spotify ids, the Discogs release
 * ids, the MusicBrainz recording MBID `mb_recording_id`), the release metadata, the AUDIO ANALYSIS (bpm/key +
 * provenance, the spectral feature vector), the MuQ EMBEDDING, and the private full-song
 * capture side-channel. All of it is derivable from the recording itself.
 *
 * What it deliberately does NOT carry is everything that means "Fluncle logged this" —
 * the Log ID coordinate, the note, the video, the observation, the found date, the
 * publish state. Those live on `findings`, keyed 1:1 by `track_id`. That split is a
 * SAFETY PROPERTY, not tidiness: because `log_id` exists only on `findings`, any query
 * that wants a coordinate MUST join, so it structurally cannot mistake a raw catalogue
 * track for a certified finding. Do not denormalise a certification field back onto this
 * table — it would dissolve the guarantee.
 *
 * TODAY every `tracks` row has a `findings` row (the archive is all certified), so the
 * inner join every finding-read performs is behaviour-preserving. Catalogue-only tracks
 * (from MusicBrainz/Discogs, with no Spotify presence — hence the NULLABLE `spotify_uri`
 * / `spotify_url`) arrive with the catalogue epic; `track_id` stays the opaque PK and
 * will simply be minted rather than borrowed from Spotify. See docs/track-lifecycle.md.
 */
export const tracks = sqliteTable(
  "tracks",
  {
    album: text("album"),
    // The GRAPH POINTER to the normalized `albums` entity (`albums.id`), the twin of
    // `labelId` below. `album` stays the raw captured string forever (the audit trail
    // and the re-normalization input); this is an ADDITION, never a replacement — the
    // pattern `docs/label-entity.md` recorded as the follow-up when the entity landed.
    //
    // WHY IT EXISTS. Slug-folding `album`/`label` in TS is fine over the FINDINGS join
    // (bounded by how many tracks Fluncle certified — a `GROUP BY` of tens of rows), and
    // that is all the entity needed while it was admin-only. The PUBLIC page asks a
    // different question — "every track on this album, including the ones Fluncle never
    // certified" — and answering that by folding the whole catalogue in the isolate is
    // exactly the shape AGENTS.md forbids (never rank/scan a growing table in the
    // Worker). An indexed equality on the entity id is a seek, at any catalogue size.
    //
    // NULL means "not linked yet": the track carries no album/label string, or its string
    // folds to a slug no entity row exists for. A LABEL row is minted off a certified finding
    // or discovered `undecided` by the crawl; an ALBUM row is minted off a certified finding OR
    // inline by the catalogue crawler (folded on the release group), so a crawled track lands
    // its `album_id` off the bat. The publish path and the crawler stamp these on the write;
    // the one-off `backfill-album-graph.ts` is history's catch-up, not a recurring deploy step.
    albumId: text("album_id"),
    albumImageUrl: text("album_image_url"),
    // BPM/key ANALYSIS PROVENANCE (RFC bpm-key-accuracy). The enrichment analyzer already
    // emits where each value came from + how confident it was; these columns persist that so a
    // preview-grade estimate is distinguishable from a full-song one, and the capture→enrich
    // race can be closed (a finding enriched from a 30s preview BEFORE its full song was
    // captured must be re-derived once the capture lands). All INTERNAL analysis metadata:
    // they are listed in `PRIVATE_TRACK_FIELDS`, so `toPublicTrackListItem` strips them from
    // every PUBLIC DTO, and writing them never bumps `findings.updated_at` (they move no
    // public surface — NOT in `track-update.ts` VISIBLE_FIELDS). Internal does NOT mean
    // stripped, though — the other two internal columns each reach the public boundary
    // differently: `features_json` IS on the public DTO (parsed onto it as `features` —
    // creative fuel for the video agent, deliberately surfaced), and `embedding_blob` is
    // simply never selected into a DTO at all. Neither passes through
    // `toPublicTrackListItem`'s strip list.
    //   - `analyzedAt`   — ISO timestamp of the analysis write.
    //   - `analyzedFrom` — which audio class the analysis ran on: "full" (the captured full
    //     song) or "preview" (a 30s preview). NULL = a legacy row written before this column;
    //     semantically "unknown, assume preview-grade" (so the capture re-derive treats NULL
    //     like "preview" — anything that is not confirmed "full" is re-enrichable).
    analyzedAt: text("analyzed_at"),
    analyzedFrom: text("analyzed_from", { enum: ["preview", "full"] }),
    // The finding's Apple Music track URL — a public listen link, the Spotify twin.
    // CATALOGUE identity (it describes the recording, not the certification), so it
    // lives here and is just as true of an uncertified track. Resolved EXACTLY by
    // ISRC via the Apple Music API (`filter[isrc]`) in the `apple-music` backfill —
    // never a fuzzy artist/title guess, so a wrong link can never render on /log
    // (the iTunes Search API has no ISRC lookup, only fuzzy term search; a term-search
    // match is unsafe for a public link, so this leg is exact-or-nothing). Stored as
    // Apple returns it (`music.apple.com/<storefront>/…`, which geo-redirects per the
    // visitor's account region). NULL until the ISRC resolves (or forever, if it never
    // does — a missing link is honest, a wrong one is not).
    appleMusicUrl: text("apple_music_url"),
    artistsJson: text("artists_json").notNull(),
    // The Apple Music backfill's per-ROW reliability state (RFC musickit-second-authority,
    // U1). These MOVED here from `findings` — and the move is the whole point. `apple_music_url`
    // is CATALOGUE identity (it describes the recording, true of an uncertified track), so the
    // Apple sweep now drains CATALOGUE rows too (a `tracks` row with no `findings` row). The
    // shipped bookkeeping lived on `findings`, where a catalogue row has no row at all —
    // `readReliability`/`recordAttempt` hard-coded `findings` and silently updated zero rows on
    // a catalogue track, so a naive catalogue sweep would re-hit every ISRC every tick forever.
    // Putting the bookkeeping on `tracks` (where the output already lives) is the capture-
    // side-channel precedent, not the Discogs one: it makes the sweep resumable over the WHOLE
    // catalogue. Same four-column shape + rules as the surviving `backfill_*` sets on `findings`
    // (see the block there): *AttemptedAt drives the failure-scaled cooldown, *Failures is the
    // consecutive-failure streak, *DoneAt stamps when the ISRC RESOLVED to a URL (a clean
    // no-match is a `tried`, re-checkable if Apple's catalogue grows). Discogs/Last.fm/note stay
    // on `findings` — they are finding-only sweeps. NULL/0 on rows that predate the columns.
    // The one-time carry of existing findings' Apple state (a gated deploy step, the
    // `labels_seeded_at` precedent) has run in production; its now-vestigial `findings`
    // columns and the carry script were dropped once it proved out.
    backfillAppleMusicAttemptedAt: text("backfill_apple_music_attempted_at"),
    backfillAppleMusicAttempts: integer("backfill_apple_music_attempts").notNull().default(0),
    backfillAppleMusicDoneAt: text("backfill_apple_music_done_at"),
    backfillAppleMusicFailures: integer("backfill_apple_music_failures").notNull().default(0),
    bpm: real("bpm"),
    // The analyzer's confidence in `bpm` (0..1) and where it came from (analysis
    // provenance, RFC bpm-key-accuracy). `bpmSource` is the analyzer's `bpmSource`
    // verbatim ("audio-file" | "deezer:search" | "itunes" | "acousticbrainz" | …). Both
    // INTERNAL (never in a public DTO, never bump `updated_at`). See `analyzedFrom` above.
    bpmConfidence: real("bpm_confidence"),
    bpmSource: text("bpm_source"),
    // The full-song capture side-channel state (RFC full-audio). Models
    // `enrichment_status` exactly — `notNull().default("pending")` is load-bearing:
    // `publishTrack`'s insert never names this column, so the DDL default is what
    // lands `'pending'` on a new add AND backfills every existing row to `'pending'`
    // on migration (which enqueues the whole archive for capture-backfill for free).
    // Enum: pending (never attempted) → done (key written) | unmatched (no confident
    // match — terminal) | failed (attempt threw — retriable under backoff).
    // ── THE EAR: the precomputed catalogue ranking (docs/the-ear.md) ─────────────
    // Six columns (the five below + `duplicate_of_track_id`), written ONLY by the
    // `rank_catalogue` sweep, and meaningful ONLY on a CATALOGUE track (a `tracks` row with no
    // `findings` row). They stay NULL on a
    // certified finding — the sweep anti-joins `findings` and never touches one — so a
    // non-null `nearest_finding_score` is itself a catalogue marker.
    //
    // WHY PRECOMPUTED. Ranking the catalogue against the findings at request time is a
    // CROSS JOIN: 10k catalogue rows × 60 findings = 600k 1024-d cosine ops per page
    // load. The sweep does that arithmetic once, in SQL, and stores the answer; `/admin/
    // catalogue` then reads and sorts an indexed column — no vector math on the request
    // path at all. Same shape as the cluster engine's assignment sweep
    // (docs/agents/cluster-engine.md): a periodic job precomputes, the surface reads.
    //
    // `capture_priority` — 0..3, the PRE-AUDIO proximity tier, and the capture queue's
    //   sort key. Audio capture is metered, so it cannot be run on everything: this is
    //   how the queue decides who gets captured (and therefore embedded, and therefore
    //   rankable) first. It exists because of a real chicken-and-egg — a track has no
    //   vector until its audio is captured, so the vector cannot be what prioritises the
    //   capture. The tiers are the cheap metadata signals that CAN: 3 = an artist on this
    //   track is already on a finding, 2 = its label already carries a finding, 1 = its
    //   label is one the operator seeds from, 0 = nothing ties it to the archive.
    // `nearest_finding_score` — cosine similarity (1 − `vector_distance_cos`, so higher
    //   is nearer) to the single NEAREST finding. NOT the distance to a centroid: the
    //   operator's taste is multi-modal (the k=4 galaxy fit proved it), and a mean vector
    //   is a place none of his taste actually lives. NULL until this row has a vector.
    // `nearest_finding_track_id` — WHICH finding it matched. This is the row's WHY, and
    //   it is not decoration: a bare score is not a reason, and a telescope you cannot
    //   interrogate is one you stop trusting.
    // `catalogue_rank_corpus` — the fingerprint of the finding corpus the two values above
    //   were computed against, `"<findings>:<embedded findings>"`. It is the staleness
    //   predicate and it makes the sweep self-healing: log a finding (or embed one) and
    //   the fingerprint moves, so every catalogue row disagrees with it and re-ranks on
    //   the next ticks. NULL = never ranked (the fresh-crawl queue).
    // `catalogue_ranked_at` — ISO of that ranking. Freshness, for the operator and the
    //   sweep's own summary; never a predicate.
    capturePriority: integer("capture_priority"),
    // The full-song capture side-channel state (RFC full-audio). Models
    // `enrichment_status` exactly — `notNull().default("pending")` is load-bearing:
    // `publishTrack`'s insert never names this column, so the DDL default is what
    // lands `'pending'` on a new add AND backfills every existing row to `'pending'`
    // on migration (which enqueues the whole archive for capture-backfill for free).
    // Enum: pending (never attempted) → done (key written) | unmatched (no confident
    // match — terminal) | failed (attempt threw — retriable under backoff).
    // Two more states carry the WRONG-AUDIO quarantine (docs/the-ear.md § Wrong audio),
    // written by the `rank_catalogue` sweep on a CATALOGUE row, never on a finding:
    //   - wrong-audio: the capture landed the wrong master (a near-1.0 cross-title match to a
    //     finding). The vector + score are nulled and the row re-queues for a fresh download; the
    //     bad `source_audio_key` is KEPT so the capture sweep can refuse the identical bytes. It
    //     is a re-capture trigger in the capture queue and a guard the embed/analyze queues honour.
    //   - quarantine-cleared: the operator's `clear_wrong_audio` override — "this capture is fine".
    //     A sticky state the sweep never re-quarantines; its kept audio re-embeds and re-ranks.
    captureStatus: text("capture_status").notNull().default("pending"),
    // THE CAPTURE VERIFICATION VERDICT (docs/the-ear.md § Wrong audio). The captured full song is
    // fingerprint-checked (Chromaprint) against the track's ISRC-resolved OFFICIAL 30s preview at
    // ingest — the one reference that is the RIGHT recording by construction, since every human
    // surface plays it, not the captured file. This column records that verdict, so a wrong
    // capture (inaudible everywhere but poisoning analysis + the MuQ ranking space) can be caught.
    // Enum:
    //   - preview-match: the captured audio matched the preview (same recording). The good case.
    //   - unverified: the gate ABSTAINED — the track has no preview source to check against, or
    //     fpcalc was absent/failed. Capture proceeded; this is an honest "no reference", not a pass.
    //   - mismatch: the captured audio does NOT match the preview. On a FINDING it is a stamp and
    //     nothing more (a machine does not rewind a public finding) — it raises an /admin attention
    //     item and the operator rules with `flag_wrong_audio`. On a CATALOGUE row it rides ALONGSIDE
    //     the wrong-audio quarantine (capture_status = 'wrong-audio') as the lens's honest WHY — a
    //     preview mismatch, not a cross-title archive collision — and the fresh capture's ingest
    //     gate overwrites it when the re-download lands.
    //   - null: pre-gate legacy (captured before verification shipped), or a fresh row not yet checked.
    // Machine-measured provenance like `analyzed_from`: internal, never a public surface, never a
    // lastmod bump. A fresh (re-)capture clears it so the new bytes are re-verified.
    captureVerification: text("capture_verification"),
    // ISO of the last capture-verification check (paired with `capture_verification`). Null until
    // verified. The historic backfill (verify-captures) never re-checks a stamped row, so this
    // doubles as its resume watermark alongside the null-verification predicate.
    captureVerifiedAt: text("capture_verified_at"),
    catalogueRankCorpus: text("catalogue_rank_corpus"),
    catalogueRankedAt: text("catalogue_ranked_at"),
    // THE DEMAND SIGNAL (docs/catalogue-crawler.md § Demand). The summed Simple Analytics
    // pageviews of the DEMANDED entities this track hangs off — an artist on it (via
    // `track_artists`) or its `label_id` — that real visitors looked at over the trailing
    // window. It is a RANK-ORDER-ONLY reorder key, never a magnitude and never an override:
    // the capture work queue (track-work.ts) reads it as a SECONDARY sort AFTER
    // `capture_priority` (within-tier only), and the `capture_priority >= 0` veto still wins,
    // so a ruled-out-label row is never resurrected by demand. Written ONLY by the
    // `record_demand` op, which CLEARS every score then re-sets — a bounded, idempotent,
    // deterministic rewrite the derived sweeps (rank_catalogue's `capture_priority`) never
    // touch. NULL on a row no demanded entity hangs off (the common case).
    demandScore: integer("demand_score"),
    // THE OPERATOR'S "NOT FOR ME" (docs/the-ear.md § The operator's actions). An ISO stamp,
    // written ONLY on a catalogue row when the operator dismisses it from the ear/capture
    // workstation — "I looked, it is not for me." It is a REVERSIBLE veto (the operator can
    // restore it), and it is exactly the ruled-out-label veto's class: it decides what The Ear
    // keeps pointing at and what the capture ladder may buy, never what is stored. A dismissed
    // row keeps its `tracks` row untouched; it simply drops out of every ranking read and the
    // capture work queue (catalogue.ts + track-work.ts filter `dismissed_at is null`), and is
    // restorable from the "Dismissed" lens. NULL on every live catalogue row and every finding —
    // dismissal is a catalogue-only act. The partial index below keeps both the restore listing
    // and the exclusion filter a seek rather than a scan of the growing catalogue.
    dismissedAt: text("dismissed_at"),
    // THE DUPLICATE MARKER (docs/the-ear.md § Duplicates). The `track_id` of the certified
    // finding this catalogue row is the SAME RECORDING as — set only by the `rank_catalogue`
    // sweep, only on a catalogue row, when the row's `isrc` (non-null, non-empty) exactly
    // matches a finding's `isrc`. NULL on every other row (no ISRC match, a finding, or a row
    // whose match was cleared because the finding was deleted).
    //
    // It exists because a crawled duplicate of a logged track is worthless to buy: the money
    // saver is catching it BEFORE audio is captured. The VETO itself rides `capture_priority`
    // (a duplicate is written the −2 tier, so the capture queue's existing `capture_priority
    // >= 0` predicate excludes it — no new predicate), and this column carries WHICH finding,
    // so the board can name it ("already in the archive") instead of the row silently
    // vanishing. The similarity half (a scored row at ≥ 0.995 cosine) is display-only and does
    // NOT write here — it reads its finding off `nearest_finding_track_id`.
    duplicateOfTrackId: text("duplicate_of_track_id"),
    durationMs: integer("duration_ms").notNull(),
    // The finding's MuQ audio embedding, in the form the DATABASE can rank: a native
    // libSQL `F32_BLOB(1024)`. Every similarity read (`get_similar_findings`, the `/mix`
    // rail, a galaxy's core-first order, the `fluncle-cluster` corpus read) ranks with
    // `vector_distance_cos(embedding_blob, ?)` IN SQL and ships back only the winners —
    // never the vectors. This is the SOLE stored form and the source of truth: the
    // agent-tier `update_track` path writes it directly via `vector32(?)` (the validated
    // JSON converted server-side; the Worker never encodes a vector). Internal analysis
    // fuel like `features_json`, so writing it moves no public lastmod. NULL until the
    // `fluncle-embed` cron drains the `embedding_blob IS NULL` queue. See
    // lib/server/embedding.ts for the read contract (`readEmbeddingBlob`) and the
    // raw-blob probe binding.
    embeddingBlob: float32Vector("embedding_blob"),
    featuresJson: text("features_json"),
    // The Discogs release the finding resolves to (read-only enrichment, best-effort,
    // matched by artist + title since Discogs has no ISRC search). inMasterId is the
    // master that groups a release's versions (Discogs returns it on the search hit);
    // inReleaseId is the specific release. The `discogs.com/release/{inReleaseId}` URL
    // is a per-finding `sameAs` for the track (distinct from the artist-level sameAs).
    // Both null until a confident match writes them on add.
    inMasterId: integer("in_master_id"),
    inReleaseId: integer("in_release_id"),
    isrc: text("isrc"),
    key: text("key"),
    // The analyzer's confidence in `key` (0..1) and its source (analysis provenance, RFC
    // bpm-key-accuracy). `keySource` is the analyzer's `keySource` verbatim. `key` is NULL
    // when confidence fell below the analyzer's floor, so `keyConfidence` records that the
    // gate ran. Both INTERNAL (never in a public DTO, never bump `updated_at`). See
    // `analyzedFrom` above.
    keyConfidence: real("key_confidence"),
    keySource: text("key_source"),
    label: text("label"),
    // The GRAPH POINTER to the normalized `labels` entity (`labels.id`) — the twin of
    // `albumId` above; see its comment for why the pointer exists and what NULL means.
    labelId: text("label_id"),
    // ── THE CANONICAL KG JOIN KEY (the MusicBrainz identity layer) ───────────────────────────
    // The MusicBrainz RECORDING MBID — the one identifier that reconciles a track to the wider
    // open music graph (MusicBrainz, Wikidata, and everything that keys off them). CATALOGUE
    // identity (it describes the recording, not the certification), so it lives here and is just
    // as true of an uncertified track. Three fill paths (docs/catalogue-crawler.md):
    //   - a CRAWLER-born row already carries it in its PK — `track_id` is `mb_<recording-mbid>`
    //     by construction — so the crawler ALSO stamps it here at mint time (crawl.ts), and one
    //     idempotent SQL strip backfills history (recording-mbids.ts § the prefix strip).
    //   - a FINDING/Spotify-born row (`track_id` is a Spotify id) resolves it by ISRC through the
    //     shared MusicBrainz client (`backfill_recording_mbids` — recording-mbids.ts).
    // PUBLIC identity, like `isrc`: it feeds the `/log` MusicRecording's `sameAs`
    // (`https://musicbrainz.org/recording/<mbid>`) + a KG `identifier` PropertyValue, so it is
    // NOT in `PRIVATE_TRACK_FIELDS`. NULL until a fill path lands it (or forever if MB has no
    // recording for the ISRC — a missing anchor is honest, never guessed).
    mbRecordingId: text("mb_recording_id"),
    // The ISRC→recording resolve ATTEMPT stamp — the reliability marker that drains the
    // `backfill_recording_mbids` worklist. Stamped on EVERY terminal attempt (a hit AND a clean
    // miss), so a track whose ISRC MusicBrainz has no recording for is not re-queried on every
    // tick forever (the `source_audio_attempted_at` / `spotify_anchor_attempted_at` discipline).
    // NULL until the row has ever been attempted; a crawler/mint fill sets `mb_recording_id`
    // directly and never needs this. Internal reliability state — no public surface, no lastmod.
    mbRecordingIdAttemptedAt: text("mb_recording_id_attempted_at"),
    // The Ear's two ranking outputs. See the block comment on `capture_priority` above —
    // these three columns are one unit and are written only by the `rank_catalogue` sweep.
    nearestFindingScore: real("nearest_finding_score"),
    nearestFindingTrackId: text("nearest_finding_track_id"),
    popularity: integer("popularity"),
    // Operator-only archive path for the one official 30s preview preserved for
    // private analysis/model training. Never exposed through public DTOs and
    // never used by /api/preview playback.
    previewArchiveKey: text("preview_archive_key"),
    previewArchiveMime: text("preview_archive_mime"),
    previewArchiveSource: text("preview_archive_source"),
    previewArchivedAt: text("preview_archived_at"),
    previewUrl: text("preview_url"),
    releaseDate: text("release_date"),
    // ISO of the last full-song capture ATTEMPT — stamped on EVERY terminal outcome
    // (done | unmatched | failed), because every one of them is a metered proxy request
    // that was billed. Two readers, and the second is why it is stamped on success too:
    //   - the backoff-cooldown anchor (grows with `source_audio_failures`), which only
    //     ever looks at `capture_status = 'failed'` rows, so the wider stamp is inert there;
    //   - the CAPTURE BUDGET's rolling-24h ledger (./capture-budget.ts) — "how many
    //     downloads did the catalogue buy today" is a range seek on THIS column, which is
    //     only true if a success stamps it as well as a failure.
    // Null until tried.
    sourceAudioAttemptedAt: text("source_audio_attempted_at"),
    // The SIZE of the captured full song in bytes — the meter behind the capture budget's
    // byte cap. Written by the capture sweep alongside the key; null on a legacy row
    // captured before the meter existed (the ledger coalesces those to 0, so an old
    // capture cannot silently inflate today's spend). See ./capture-budget.ts.
    sourceAudioBytes: integer("source_audio_bytes"),
    // ISO stamp when the full-song bytes landed in R2. Null until captured.
    sourceAudioCapturedAt: text("source_audio_captured_at"),
    // CONSECUTIVE capture failures (reset to 0 on success); drives the backoff window.
    sourceAudioFailures: integer("source_audio_failures").notNull().default(0),
    // The R2 key of the captured full song (`<logId>/<sha256>.<ext>` in the private
    // `fluncle-source-audio` bucket). PRESENCE = captured. Null until then.
    sourceAudioKey: text("source_audio_key"),
    // THE BAD-AUDIO MEMORY (docs/the-ear.md § Wrong audio) — a JSON array of the sources this
    // track's captures have been REJECTED from, capped at the newest ~10 ({ videoId?, sha256,
    // reason, at }). It is the general form of the single-sha memory the old quarantine embedded in
    // a kept `source_audio_key`: two filters ride it in the capture sweep. The `videoId` is the
    // cheap PRE-download filter (a known-bad candidate never costs proxy bytes again); the `sha256`
    // is the deep backstop (the same audio re-uploaded under a NEW id is rejected post-download and
    // remembered). Written by the sweep's ingest gate on a mismatch, and by the wrong-audio
    // quarantine + the operator's `flag_wrong_audio` when they rewind a row. Null until the first
    // rejection. Internal, like the rest of the capture side-channel — no public surface, no lastmod.
    sourceAudioRejected: text("source_audio_rejected"),
    // THE ANCHOR RE-ASK STAMP (docs/catalogue-crawler.md § the anchor). ISO of the last
    // Spotify-anchor ATTEMPT on a catalogue row, stamped on EVERY attempt — a hit AND a
    // miss — by the agent-tier `anchor_track` op the box's Apify anchor sweep POSTs to. It
    // is the backoff the anchor worklist reads: "not on Spotify today" is not "never on
    // Spotify" (a small-label recording lands on Spotify weeks later), so a missed row is
    // re-asked, but only after a window (track-work.ts `ANCHOR_REASK_AFTER_DAYS`) — every
    // re-ask costs real Apify money. NULL until the row has ever been attempted. Internal,
    // like the rest of the catalogue side-channel — no public surface, no lastmod bump.
    spotifyAnchorAttemptedAt: text("spotify_anchor_attempted_at"),
    // NULLABLE (they were NOT NULL until the tracks/findings split): a catalogue track
    // resolved from MusicBrainz/Discogs may have no Spotify presence at all. `track_id`
    // stays the opaque PK — today it happens to be the Spotify id; a catalogue-only track
    // gets a minted one. Everything keyed on `track_id` (track_artists, mixtape_tracks,
    // social_posts, user_saved_findings, user_galaxy_collections) is unaffected.
    spotifyUri: text("spotify_uri"),
    spotifyUrl: text("spotify_url"),
    title: text("title").notNull(),
    trackId: text("track_id").primaryKey(),
  },
  // Every list/queue/feed order and predicate for a FINDING lives on the certification
  // half (added_at, log_id, video_url, enrichment_status, galaxy_id), so the four former
  // `tracks_*` indexes moved wholesale to `findings` below; a finding read drives from
  // `findings` and joins `tracks` by its PRIMARY KEY.
  //
  // Everything indexed HERE is a CATALOGUE-half scan shape — a read that drives from
  // `tracks` (the table the catalogue grows), not from `findings`, and therefore must stay
  // a seek rather than a scan as it does. Three PRs index this table for three jobs:
  //
  // The GRAPH pages read `tracks` BY ENTITY: every track on this album / this label,
  // certified or not (the public `/album/<slug>` + `/label/<slug>` pages, docs/album-entity.md).
  // Both pointers also serve a backfill's `… _id is null` drain — `label_id` the recurring
  // labels deploy backfill, `album_id` the one-off `backfill-album-graph.ts` catch-up.
  //   - `album_id` / `label_id` — the entity a track hangs off.
  //
  // The EAR's two ordered reads are the whole reason its request path does no vector math
  // (docs/the-ear.md). Both walk their index DESC and stop at the page's LIMIT, so the cost
  // is the page, not the corpus. NULLs sort first in an ASC index, so a DESC walk hits the
  // ranked rows first and never pays for the unranked tail. Neither column is ever non-null
  // on a finding (the sweep anti-joins `findings`), so both hold catalogue rows only.
  //   - `nearest_finding_score` — the Ear's rank: "closest to a finding, not yet logged."
  //   - `capture_priority`      — the capture queue's rank: who gets captured next.
  //
  // The CAPTURE BUDGET's rolling-24h ledger (./capture-budget.ts) asks one question of this
  // table — "what did the catalogue spend in the last 24h?" — and it must stay a SEEK, because
  // it is read on every capture-queue tick and every /admin/catalogue load, against the one
  // table the crawler grows without bound. It is a range predicate on the attempt stamp, so:
  //   - `source_audio_attempted_at` — the ledger's window. NULLs sort first in an ASC index,
  //     so a `>= cutoff` seek skips every never-attempted row (which is nearly all of them)
  //     and reads only the window — and the window is itself bounded by the budget the ledger
  //     is enforcing. The cost of the brake cannot grow with the catalogue.
  //
  // The CRAWLER's two write-side reads (docs/catalogue-crawler.md). The Ear ranks what
  // exists and the graph pages render it; the crawler is what makes the rows exist, and its
  // two hot predicates are properties of the RECORDING rather than of the certification.
  //   - `isrc`                — the idempotence check, before minting a row.
  //   - the partial anchor idx — the derived Spotify-anchor worklist.
  (table) => [
    index("tracks_album_id_idx").on(table.albumId),
    index("tracks_label_id_idx").on(table.labelId),
    // The `/fresh` window read ("what just came out"): `release_date BETWEEN <30d ago> AND
    // <today>` ordered `release_date DESC`. Over a table built to grow to five figures, an
    // unindexed range scan is exactly the full scan of a growing table AGENTS.md forbids, so
    // release_date is a btree index — the range predicate + the ORDER BY both ride it, and the
    // window bounds the scan to ~a month of rows however big the catalogue gets. A plain btree
    // over a text column (not the vector `libsql_vector_idx` that wedges hosted Turso), so it
    // builds like `tracks_key_idx` / `tracks_isrc_idx` beside it.
    index("tracks_release_date_idx").on(table.releaseDate),
    // The `/tracks` hub's BPM-range filter (`bpm >= ? and bpm <= ?`) over the whole-archive
    // browse list. A plain ASC btree — SQLite reverse-scans it, and a `desc()` index would poison
    // the drizzle snapshot into rebuilding every index on the next migration (the ratified trap).
    // The hub's primary sort still rides `tracks_release_date_idx`; this index earns its keep for a
    // narrow BPM range the planner can seek rather than filtering every scanned row. Builds like the
    // `tracks_key_idx` btree beside it (never the vector `libsql_vector_idx` that wedges hosted Turso).
    index("tracks_bpm_idx").on(table.bpm),
    index("tracks_nearest_finding_score_idx").on(table.nearestFindingScore),
    index("tracks_capture_priority_idx").on(table.capturePriority),
    index("tracks_source_audio_attempted_at_idx").on(table.sourceAudioAttemptedAt),
    // THE CAPTURE-MISMATCH ATTENTION READ (attention.ts `listCaptureSuspectRows`, docs/the-ear.md
    // § Wrong audio). The /admin attention queue's suspect list is `capture_verification =
    // 'mismatch'` ordered `capture_verified_at ASC` — over a table designed to grow to five figures,
    // an unindexed filter on `capture_verification` is the full scan of a growing table AGENTS.md
    // forbids (measured ~5s p95 in prod). A COMPOSITE btree seeks it: the leading column turns the
    // `= 'mismatch'` filter into a range seek, and the trailing column serves the `ORDER BY
    // capture_verified_at ASC` from the index instead of a sort (`track_id` is the PK tiebreaker, so
    // it need not be in the index). It also serves the backfill worklist's `capture_verification is
    // null` seek (catalogue.ts `listUnverifiedCaptures`) off the same leading column. PLAIN ASC
    // columns — a `desc()` index would poison the drizzle snapshot into rebuilding every index on the
    // next migration (the ratified trap) — and a plain btree, never the vector `libsql_vector_idx`
    // that wedges hosted Turso, so it builds like `tracks_key_idx` beside it.
    index("tracks_capture_verification_verified_at_idx").on(
      table.captureVerification,
      table.captureVerifiedAt,
    ),
    // The crawler's idempotence check — "do we already hold this ISRC?" — before minting a
    // row. A predicate on `tracks.isrc` over a table designed to grow to five figures, so
    // it is indexed. NOT unique: an ISRC is not guaranteed distinct across the archive's
    // history, and a unique index would turn a vendor's duplicate ISRC into a failed
    // migration; the crawler dedupes by READING this index, never by trusting a constraint.
    index("tracks_isrc_idx").on(table.isrc),
    // The Spotify-anchor GAUGE index, and a PARTIAL index because the queue is DERIVED rather
    // than bookkept: "which catalogue rows have an ISRC but no Spotify id yet" is the ISRC-bearing
    // slice `get_crawl_status` reports as `anchorsPending`. The partial predicate keeps this index
    // tiny and — the nice part — SHRINKING as the anchors fill, instead of growing with the table.
    // (The anchor WORKLIST the box drains is wider — every un-anchored catalogue row — and rides
    // `tracks_anchor_fill_queue_idx` below; see track-work.ts `kind: "anchor"`.)
    index("tracks_anchor_queue_idx")
      .on(table.isrc)
      .where(sql`${table.spotifyUri} is null and ${table.isrc} is not null`),
    // The MusicBrainz-recording-MBID fill queue — "no `mb_recording_id` yet, and not yet
    // attempted" (recording-mbids.ts, `backfill_recording_mbids`). PARTIAL for the anchor
    // queue's reason: the worklist is DERIVED, and this predicate matches a SHRINKING slice of a
    // growing table (a row leaves the moment it is filled OR its ISRC resolve is stamped a miss),
    // so the index shrinks as the backlog drains rather than growing with the catalogue. It backs
    // BOTH the op's reads: the bounded `mb_` prefix-strip (history's crawler rows) and the
    // ISRC→recording API drain (findings/Spotify-born rows), both ordered by `track_id`.
    index("tracks_mb_recording_id_queue_idx")
      .on(table.trackId)
      .where(sql`${table.mbRecordingId} is null and ${table.mbRecordingIdAttemptedAt} is null`),
    // The MuQ EMBED queue — "audio on file, no vector yet" (track-work.ts, `kind: "embed"`).
    // PARTIAL, for the same reason the anchor queue is: the worklist is DERIVED, and the
    // predicate matches a shrinking slice of a growing table, so the index shrinks as the
    // backlog drains instead of growing with the archive.
    //
    // It earns its keep twice. `embedding_blob` is a 4 KB `F32_BLOB(1024)`, so a `tracks` row
    // carrying one SPILLS off the page: a full scan of the table to find the un-embedded
    // rows costs (roughly) an extra page per embedded row — the exact shape AGENTS.md warns about, and
    // it is paid on every 5-minute box tick and on every page of the GPU batch. Driving that
    // predicate off this index reads only the backlog. And it is what makes `countTrackWork`
    // affordable: the honest "how many are still queued" the batch reports is an index count,
    // not an archive scan.
    index("tracks_embed_queue_idx")
      .on(table.trackId)
      .where(sql`${table.sourceAudioKey} is not null and ${table.embeddingBlob} is null`),
    // THE SPOTIFY-ANCHOR-FILL WORKLIST (the box's Apify anchor sweep, docs/catalogue-crawler.md
    // § the anchor). PARTIAL, exactly like the anchor + embed queues above: the worklist is the
    // un-anchored catalogue (`spotify_uri is null`), a slice that SHRINKS as anchors fill rather
    // than growing with the table. It indexes `nearest_finding_score` under that predicate so the
    // sweep's ranked drain — the Ear's best un-anchored candidates first (`nearest_finding_score
    // DESC`), the "the order IS the budget" law the capture ladder lives by — is an index walk of
    // the ranked un-anchored rows, not a scan of the growing catalogue. It is a plain btree (never
    // the vector `libsql_vector_idx` that wedges hosted Turso), so it builds like the queues beside
    // it. The residual predicates the worklist adds (`duration_ms > 0`, `dismissed_at is null`,
    // `duplicate_of_track_id is null`, the re-ask backoff) are cheap filters on the small page the
    // index walk hands back — never a table scan. See track-work.ts `kind: "anchor"`.
    index("tracks_anchor_fill_queue_idx")
      .on(table.nearestFindingScore)
      .where(sql`${table.spotifyUri} is null`),
    // THE OPERATOR'S DISMISSALS — "not for me" (docs/the-ear.md § The operator's actions).
    // PARTIAL, exactly like the anchor + embed queues above: dismissals are rare (an operator
    // act, never a machine one), so the index holds a tiny, near-static slice of a growing
    // table. It serves the "Dismissed" restore listing (a seek to the dismissed rows, ordered
    // by when) and backs the `dismissed_at is null` exclusion the ranking + capture reads apply.
    index("tracks_dismissed_idx")
      .on(table.dismissedAt)
      .where(sql`${table.dismissedAt} is not null`),
    // THE DEMAND CLEAR (docs/catalogue-crawler.md § Demand). `record_demand` re-writes the demand
    // columns clear-then-set every night, and the clear is `where demand_score is not null`. At
    // catalogue scale only a few hundred rows are ever scored, so this partial index makes the
    // nightly clear (and the `tracksScored` recount) a seek to exactly those rows rather than a
    // scan of the growing `tracks` table — the `tracks_dismissed_idx` shape.
    index("tracks_demand_score_idx")
      .on(table.demandScore)
      .where(sql`${table.demandScore} is not null`),
    // The MIXABILITY pre-filter, and the one index `/mix` cannot be public without.
    //
    // The key is MANDATORY to be rankable (`scoreMix`'s floor: a pair whose key we do not
    // know is a pair we cannot justify), so a keyed row is exactly a mixable row — which
    // makes this the ratified "btree pre-filter ahead of an exact vector scan" shape from
    // docs/local-database.md, not a nice-to-have. It carries two reads:
    //
    //   - The candidate scan (`getMixableTracks`). The rail only ever wants the ~8 Camelot
    //     classes a named harmonic move can reach, so the scan is `key in (…)` — an index
    //     range, roughly a third of the archive, instead of a full scan whose every
    //     embedded row spills off the page (the `embedding_blob` spill above).
    //   - The key histogram (`getMixChainDepth`). A `group by key` over 24-ish distinct
    //     values, which this index answers WITHOUT touching the table at all.
    //
    // Both run on a public page load once the depth gate opens, over a table designed to
    // grow to five figures and beyond. Unindexed, `/mix` is a full archive scan per
    // keystroke of a chain.
    index("tracks_key_idx").on(table.key),
  ],
);

/**
 * THE CERTIFICATION LAYER — present ONLY for a track Fluncle certified.
 *
 * The SUBTYPE half of the pair: 1:1 with `tracks`, sharing its primary key
 * (`track_id`), and carrying everything that means "Fluncle logged this" — the Log ID
 * coordinate, the editorial note, the video, the spoken observation, the found date, the
 * enrichment/publish state, and the per-source backfill bookkeeping. A row here IS the
 * finding; a `tracks` row with no `findings` row is a catalogue track Fluncle has not
 * certified.
 *
 * WHY IT IS ITS OWN TABLE. A track is a track; certification is a RELATIONSHIP Fluncle
 * has with it. Keeping `log_id` here — and nowhere else — means every query that wants a
 * coordinate has to join, so it structurally cannot mistake a raw catalogue track for a
 * certified finding. That is the whole point of the split, and it is why nothing here may
 * be denormalised back onto `tracks`.
 *
 * `log_id` is NULLABLE (not the PK): a certified straggler can exist for a moment before
 * its coordinate is minted (the one-time `logId: "auto"` backfill in track-update.ts), and
 * a `/log` surface skips a coordinate-less finding. So "is a finding" = a `findings` row;
 * "has a coordinate" = `findings.log_id IS NOT NULL` — the same two-step every surface
 * already performed, now honest about it.
 *
 * `track_id` is the PK and a logical foreign key to `tracks.track_id`, declared without a
 * SQL FK constraint — matching every other relation in this schema (`social_posts`,
 * `mixtape_tracks`, `tracks.galaxy_id`, `mixtape_clips.recording_id` … "this schema
 * declares none"). See docs/track-lifecycle.md.
 */
export const findings = sqliteTable(
  "findings",
  {
    // The FOUND date — when Fluncle certified this track. The feed's sort key and the
    // sitemap's lastmod floor. It belongs to the certification, not the recording: a
    // catalogue track has a release date (on `tracks`), never a found date.
    addedAt: text("added_at").notNull(),
    addedToSpotify: integer("added_to_spotify", { mode: "boolean" }).notNull().default(false),
    addedToSpotifyAt: text("added_to_spotify_at"),
    // Per-finding backfill reliability state for the two Worker-paced catalogue
    // sweeps (Discogs release-id resolve, Last.fm love), one column-set per source.
    // The sweeps are best-effort side-channels over already-published findings; this
    // state makes them RESUMABLE and keeps them from re-storming a vendor API:
    //   - *AttemptedAt — ISO of the last attempt; the sweep skips a finding tried
    //     within a cooldown window (the window grows with the failure count, so a
    //     repeatedly-failing finding backs off instead of being retried every tick).
    //   - *Attempts    — total attempts (diagnostic / unbounded-retry guard).
    //   - *Failures    — CONSECUTIVE failures (reset to 0 on success); drives the
    //     exponential backoff window. A done/resolved finding has 0.
    //   - *DoneAt      — ISO when the source completed for this finding (Discogs:
    //     ids written; Last.fm: loved). Set ⇒ the sweep skips it forever (idempotent
    //     no-op). Null until done. All four are null on rows that predate the column.
    // The Discogs sweep's OUTPUT (`in_release_id`/`in_master_id`) is catalogue identity
    // and lives on `tracks`; only the per-finding sweep BOOKKEEPING lives here.
    //
    // The Apple Music sweep once kept the same per-source bookkeeping here, but its four
    // `backfill_apple_music_*` columns MOVED to `tracks` (RFC musickit U1) — `apple_music_url`
    // is catalogue identity and the sweep now drains catalogue rows that have no `findings`
    // row, so the bookkeeping had to live where the output does. The one-time carry of the old
    // findings state has run in production; the vestigial columns were dropped here. See the
    // `backfill_apple_music_*` block on `tracks`.
    backfillDiscogsAttemptedAt: text("backfill_discogs_attempted_at"),
    backfillDiscogsAttempts: integer("backfill_discogs_attempts").notNull().default(0),
    backfillDiscogsDoneAt: text("backfill_discogs_done_at"),
    backfillDiscogsFailures: integer("backfill_discogs_failures").notNull().default(0),
    backfillLastfmAttemptedAt: text("backfill_lastfm_attempted_at"),
    backfillLastfmAttempts: integer("backfill_lastfm_attempts").notNull().default(0),
    backfillLastfmDoneAt: text("backfill_lastfm_done_at"),
    backfillLastfmFailures: integer("backfill_lastfm_failures").notNull().default(0),
    // The auto-note authoring "ran" stamp (the written-note sibling of the observation
    // pipeline). Unlike Discogs/Last.fm this is NOT a vendor sweep — `note_track`
    // (agent tier) stamps `backfill_note_attempted_at` on EVERY authoring attempt and
    // `backfill_note_done_at` only when an empty `note` was actually FILLED. It reuses
    // the same backfill_* column convention purely so the admin board's "done-when-ran"
    // semantics and `listBackfillRanForTracks` machinery work for the Note cell exactly
    // like Discogs/Last.fm: grey/`open` = never run, `done` = the workflow ran (a note
    // exists). The operator override always wins — the handler fills an EMPTY note only,
    // never clobbering an operator-written one, so a hand-written note can carry no
    // attempt stamp and still read `done` off the `note` column itself.
    backfillNoteAttemptedAt: text("backfill_note_attempted_at"),
    backfillNoteAttempts: integer("backfill_note_attempts").notNull().default(0),
    backfillNoteDoneAt: text("backfill_note_done_at"),
    backfillNoteFailures: integer("backfill_note_failures").notNull().default(0),
    // Firecrawl-derived FACTUAL context about the track (label/year/release
    // context/artist background), gathered during the observe step as CREATIVE
    // FUEL for the observation script and the video agent. Internal only: never
    // rendered on /log, never in JSON-LD/RSS/llms.txt, never quotes lyrics. This
    // is NOT the editorial `note` (the operator's public "why").
    contextNote: text("context_note"),
    // PROVENANCE — the `context_distil` prompt version this note was distilled under
    // (docs/agents/prompt-registry.md). NULL means the prompt was not resolved from the
    // registry at all: either the row predates the registry, or the resolve fell back to
    // the module's baked-in default. A number is the `prompt_versions.version` that was
    // live at authoring time; `0` is the registry default (no operator override on file).
    // Without this column "the context notes got worse last week" is unanswerable.
    contextPromptVersion: integer("context_prompt_version"),
    // The context-fetch reliability marker (mirrors the backfill_* state above). The
    // `context_track` queue picks `pending` rows (never-attempted); this column lets a
    // CONFIRMED-EMPTY fetch (`empty`) be distinct from never-attempted, so the cron does
    // not re-burn Firecrawl + the distil LLM on a hopeless find every tick. States:
    //   - pending  — never attempted (the default; the queue's pick set).
    //   - resolved — a distilled (or cleaned-raw fallback) note was stored.
    //   - empty    — the fetch returned nothing usable; intentionally left blank. The
    //                queue skips it unless `--retry-empty` widens the pick set.
    //   - failed   — the attempt threw (vendor down); eligible for a later retry.
    // Internal only — never surfaced through public DTOs. Rows that predate the column
    // read NULL and are treated as `pending`.
    contextStatus: text("context_status", {
      enum: ["pending", "resolved", "empty", "failed"],
    }),
    enrichmentStatus: text("enrichment_status").notNull().default("pending"),
    // The sonic galaxy this finding belongs to — a nullable logical FK to `galaxies.id`,
    // the internal-grouping precedent of `embedding_blob`. Hard assignment (one galaxy
    // per finding), written by the on-box `fluncle-cluster` cron via the agent-tier
    // `update_track` path (assignment-only nightly step). Internal like the embedding, so
    // writing it moves no public lastmod (kept OUT of `VISIBLE_FIELDS`); it surfaces on
    // the public DTO only once the galaxy is operator-NAMED. NULL until the finding is
    // embedded AND assigned. Member counts are derived, never stored. A galaxy is a
    // property of the CERTIFIED archive (the browse-by-feel map is a map of findings), so
    // it sits here even though the vector it is derived from lives on `tracks`.
    // See docs/agents/cluster-engine.md + docs/track-lifecycle.md.
    galaxyId: text("galaxy_id"),
    // THE COORDINATE — the permanent Galaxy waypoint (`fluncle://<id>`), and the reason
    // this table exists. It lives HERE and nowhere else, so a query cannot reach a Log ID
    // without joining through the certification. NULL only for a straggler awaiting its
    // one-time backfill.
    logId: text("log_id").unique(),
    note: text("note"),
    // PROVENANCE — the `note_author` prompt version this editorial note was drafted
    // under. Same contract as `context_prompt_version` above. An OPERATOR-typed note
    // leaves it NULL (no prompt produced it), which is itself the honest reading.
    notePromptVersion: integer("note_prompt_version"),
    // Word-level caption timings for the spoken observation, as a JSON string
    // (`{ source, words: [{ text, startMs, endMs }] }` — see lib/server/observation.ts
    // `ObservationAlignment`). Drives the synced subtitles on the radio player (and,
    // later, /log): the current word is highlighted off `audio.currentTime`. Captured
    // at render time from Cartesia's word timestamps (a retired one-off `/forced-alignment`
    // backfill seeded older rows). Internal-but-PUBLIC: unlike the script, the
    // word timings ARE surfaced (the public TrackListItem carries them so the radio
    // caption render can read them), but they describe an EXISTING artifact, so writing
    // them does NOT bump updated_at (a backfill must move no public lastmod).
    observationAlignmentJson: text("observation_alignment_json"),
    // The audio observation (Fluncle's recovered field observation, spoken).
    // observationAudioUrl is the R2 read URL for <log-id>/observation.mp3 — set
    // when the render is uploaded; its presence is the "has observation" flag. The
    // script (observation.txt) and the structured artifact + render metadata
    // (observation.json) live by CONVENTION at <log-id>/<name> with no column,
    // exactly like poster.jpg / cover.jpg (see lib/media.ts).
    observationAudioUrl: text("observation_audio_url"),
    observationDurationMs: integer("observation_duration_ms"),
    observationGeneratedAt: text("observation_generated_at"),
    // PROVENANCE — the `observation_script` prompt version this spoken script was
    // authored under. Same contract as `context_prompt_version` above.
    observationPromptVersion: integer("observation_prompt_version"),
    // The spoken observation SCRIPT — the voice-gated prose the agent authored and
    // passed to the observe render. It already lives
    // in the R2 `observation.json` (field `text`) + `observation.txt`; this column
    // mirrors it on the row so the admin observation dialog can show the transcript
    // without an R2 round-trip, and radio.fluncle.com renders it as synced captions
    // over the footage. Internal like `context_note`: never on the
    // public TrackListItem contract — surfaced only through the admin-only board path.
    observationScript: text("observation_script"),
    postedToTelegram: integer("posted_to_telegram", { mode: "boolean" }).notNull().default(false),
    postedToTelegramAt: text("posted_to_telegram_at"),
    spotifyError: text("spotify_error"),
    telegramError: text("telegram_error"),
    // The logical FK to `tracks.track_id` AND this table's primary key — the 1:1 that
    // makes `findings` a subtype rather than a child collection. No SQL FK constraint,
    // matching the rest of this schema.
    trackId: text("track_id").primaryKey(),
    // Last content change to the finding's record: every write path (publish,
    // curation/enrichment update, social-post state) bumps it. Null for rows that
    // predate the column; readers fall back to added_at (sitemap lastmod).
    updatedAt: text("updated_at"),
    // The grain FAMILY of the track's video (e.g. "grainCoarseSilver"). Set when the
    // video is uploaded; surfaced in /api/tracks beside the vehicle so the next agent
    // reads recent grain families and diversifies (the grain ledger).
    videoGrain: text("video_grain"),
    // The AI model that authored the track's video, in <provider>/<model> notation
    // (e.g. "anthropic/claude-opus-4-8"). Set when the video is uploaded; surfaced
    // in /api/tracks alongside the vehicle. Defaults so existing rows backfill.
    videoModel: text("video_model").default("anthropic/claude-opus-4-8"),
    // The reasoning/thinking effort the authoring model ran at (e.g. "high",
    // "medium", "low"). Set when the video is uploaded; surfaced in /api/tracks so
    // we can compare model × thinking level. Defaults to "high" — the existing
    // videos were authored at high reasoning, so existing rows backfill.
    videoModelReasoning: text("video_model_reasoning").default("high"),
    // The coarse palette HUE-BUCKET tag of the track's video (e.g. "amber-warm"), derived
    // deterministically from the render's palette (palette-summary.ts). Set when the video
    // is uploaded; surfaced beside vehicle/grain/register so the next (ephemeral) video
    // agent — via the deterministic axis assigner — steers off a worn hue. This is the
    // palette axis that was invisible when four consecutive renders shared one amber look
    // (docs/planning/homogenisation-evidence.md). Null = not recorded (older rows / no
    // palette derivable).
    videoPalette: text("video_palette"),
    // The plate-lane SUBJECT KIND of the track's video (e.g. "hull" / "ruin" / "flora" /
    // "creature" / "terrain" / "threshold"), lifted from the bundle's render.json `plateSubject`.
    // Set when the video is uploaded; the plate-subject diversity axis judge:diversity reads to
    // rotate plate subjects. NULL on plate-less (abstract/procedural) renders and older rows that
    // predate the column — the provenance render.json always carried but never persisted (Wave-1 C).
    videoPlateSubject: text("video_plate_subject"),
    // The visual REGISTER of the track's video — the composition's mode:
    // "abstract" | "representational" | "framed". Set when the video is uploaded;
    // surfaced in /api/tracks alongside the vehicle and grain so the next
    // (ephemeral) video agent reads recent registers and diversifies (the register
    // ledger). Null = not recorded (older rows predate the column).
    videoRegister: text("video_register"),
    // The two-master video layout signal. NON-NULL once
    // the SQUARE crop source has been uploaded as footage.mp4 — i.e. this finding's
    // footage.mp4 is now the clean 1920×1920 master MT crops on the fly, and a baked
    // portrait footage.social.mp4 rides alongside. NULL = the legacy single-file
    // layout (footage.mp4 is still the old portrait+text cut); consumers fall back to
    // today's behavior. Set by the video finalize/upload path, never by the
    // footage.mp4 → footage.social.mp4 R2 rename migration (that copy alone doesn't
    // make footage.mp4 square). The presence of the timestamp is the only thing read.
    videoSquaredAt: text("video_squared_at"),
    // The dominant STRUCTURAL family the render's resolved shader body classifies to
    // (cellular / flow / caustic / filament / lattice / radial / metaball / other), lifted from
    // the bundle's render.json `structure.dominant`. The CHECKED diversity axis beside the
    // free-text vehicle NAME — set when the video is uploaded so a creatively-named repeat can't
    // hide. NULL when the body couldn't be classified or on rows that predate the column (Wave-1 C).
    videoStructure: text("video_structure"),
    videoUrl: text("video_url"),
    // The travelling vehicle of the track's video (e.g. "voronoi cellular",
    // "caustic web"). Set when the video is uploaded; surfaced in /api/tracks so
    // the next (ephemeral) video agent can read recent vehicles and diversify.
    videoVehicle: text("video_vehicle"),
  },
  (table) => [
    // The feed/cursor order every list surface pages by (listTracks:
    // `order by added_at, track_id` + the keyset cursor comparator). It drives from
    // `findings` and joins `tracks` by PK, so this index carries the whole feed.
    index("findings_added_at_track_id_idx").on(table.addedAt, table.trackId),
    // The galaxy lens + the ratified vector-scan btree pre-filter (tracks.ts documents
    // the shape; `getFindingsByGalaxyRanked` is the predicate).
    index("findings_galaxy_id_idx").on(table.galaxyId),
    // Radio/video eligibility (`where video_url is not null`).
    index("findings_video_url_idx").on(table.videoUrl),
    // Enrichment queue filters (listTracks' `status` filter).
    index("findings_enrichment_status_idx").on(table.enrichmentStatus),
  ],
);

// The radio.fluncle.com shared-schedule anchor (the radio-broadcast RFC, Unit A).
// ONE row (PK = service = "radio") holding the wall-clock `epoch` the modulo
// schedule is measured from and the `version` fingerprint of the eligible set it
// was computed for (`${count}:${maxObservationGeneratedAt}`). The broadcast is a
// pure function of (deterministic eligible list, per-segment duration, epoch):
// `p = (now − epoch) mod T`. The stored epoch is the ONE thing a pure function
// can't derive — *when* a catalogue change takes effect. When the eligible set
// changes (`version` no longer matches the live fingerprint), `now-playing`
// rolls the epoch forward to the next loop boundary (`epoch += ⌈(now−epoch)/T⌉·T`)
// and rewrites this row, so a grown catalogue applies at the seam and no current
// listener's playhead jumps. This is a lazy self-heal on the READ path — the
// eligibility-changing agent writes (observe / square backfill) never touch it.
export const radioSchedule = sqliteTable("radio_schedule", {
  // The wall-clock anchor (ms since epoch) the modulo schedule is measured from.
  epochMs: integer("epoch_ms").notNull(),
  // When this row was last (re)computed — provenance for the boundary roll.
  generatedAt: text("generated_at").notNull(),
  // Single-row table: a fixed PK so the row is upserted, never duplicated.
  service: text("service").primaryKey(),
  // The eligible-set fingerprint this epoch was computed for:
  // `${count}:${maxObservationGeneratedAt}`. A mismatch with the live fingerprint
  // is the "the schedule changed" trigger.
  version: text("version").notNull(),
});

// The public status dashboard's current-state snapshot — ONE row per probed
// service (PK = `service`, so each check upserts its single row, the
// `radio_schedule`/`spotify_auth` single-row precedent). A Hermes cron probes
// the services and POSTs a snapshot to the agent-tier `record_health` op; this
// table is what /status reads. `status` is the three-state health enum (plain
// TEXT, the enum only narrows the type — widening needs no migration). `since`
// is when the CURRENT status began (carried forward across an upsert while the
// status is unchanged, reset to `checked_at` on a transition), so the page can
// render "up 3d" / "down 12m". PUBLIC-SAFE by construction: only the service
// name, status, a short message, latency, and timestamps live here — never an
// IP, hostname, op-path, or raw error body.
export const serviceStatus = sqliteTable("service_status", {
  // When this row was last refreshed by a probe (ISO). Equals the POSTed `at`.
  checkedAt: text("checked_at").notNull(),
  // Round-trip latency of the last probe, in ms. Null when not measured.
  latencyMs: integer("latency_ms"),
  // A short, public-safe human message (e.g. "elevated p95", "timed out"). Null
  // when nothing to say. NEVER a raw error body / internal address.
  message: text("message"),
  // The probed service (PK): one of web/db/r2/dns/ssh/onion/hermes/render-box,
  // but plain TEXT so a new service needs no migration.
  service: text("service").primaryKey(),
  // When the CURRENT status began (ISO) — preserved across upserts while the
  // status is unchanged, reset to `checked_at` on a transition. Drives the
  // human "up 3d" / "down 12m" uptime/downtime read on /status.
  since: text("since").notNull(),
  // The three-state health enum (plain TEXT; the enum only narrows the type).
  status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
});

// The append-only status TRANSITION ledger — one row per status change (the
// probe POSTs `transitioned: true` for the check that flipped). Feeds the
// compact "recent events" feed on /status. Pruned to the most recent 200 rows
// on every write (a status page never needs deep history), indexed on `at` for
// the recent-first read + the prune's keep-set. PUBLIC-SAFE like
// `service_status`: service + status + short message + time only.
export const statusEvents = sqliteTable(
  "status_events",
  {
    // When the transition happened (ISO). Equals the POSTed snapshot `at`.
    at: text("at").notNull(),
    id: text("id").primaryKey(),
    // A short, public-safe human message for the transition. Null when none.
    message: text("message"),
    // The service that transitioned.
    service: text("service").notNull(),
    // The status it transitioned INTO (same three-state enum as service_status).
    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("status_events_at_idx").on(table.at)],
);

// The append-only per-check SAMPLE ledger — one row per probed service per snapshot
// (every ~10m tick). Drives the recent-uptime bar on /status: a strip of the last N
// checks per service, coloured by status, that fills in over time. Pruned per-service
// to the most recent samples on every write (bounded without a cron), indexed on
// (service, at) for the per-service recent-first read + the prune's keep-set.
// PUBLIC-SAFE like the others: service + status + latency + time only.
export const serviceCheckSamples = sqliteTable(
  "service_check_samples",
  {
    // When the sample was taken (ISO). Equals the POSTed snapshot `at`.
    at: text("at").notNull(),
    id: text("id").primaryKey(),
    // Round-trip latency of this probe, in ms. Null when not measured.
    latencyMs: integer("latency_ms"),
    // The probed service.
    service: text("service").notNull(),
    // The three-state health enum at this sample (same enum as service_status).
    status: text("status", { enum: ["ok", "degraded", "down"] }).notNull(),
  },
  (table) => [index("service_check_samples_service_at_idx").on(table.service, table.at)],
);

// The live-set callout flag — the single, ephemeral "Fluncle is on the decks
// right now" beat that fans out across every surface while the Twitch stream is
// on, then clears the moment it ends. ONE row (PK = the constant `"twitch"`),
// upserted each minute by the on-box `fluncle-live` poller via the agent-tier
// `record_live_state` op — exactly the `service_status` shape (a box cron writes, every
// surface reads), just a single boolean+title instead of a per-service grid.
//
// Auto-clear is READ-side: a consumer treats the flag as offline when `updated_at`
// is older than the staleness window, so a dead cron mid-set can never strand a
// permanent "LIVE" banner — it self-heals regardless of cron health.
//
// PUBLIC-SAFE by construction: only the live boolean, the public stream title,
// the Twitch `started_at`, and our own timestamps live here. `tg_message_id` is
// the pinned crew message's id (so the on→off transition can unpin it) — a
// Telegram message id in our own channel, not sensitive.
export const liveState = sqliteTable("live_state", {
  // Single-row PK — the constant "twitch". One channel, one row.
  id: text("id").primaryKey(),
  // Whether Fluncle is live on the decks right now (the last POSTed Twitch state).
  live: integer("live", { mode: "boolean" }).notNull(),
  // When the current stream started (ISO, Twitch `started_at`). Null when offline.
  startedAt: text("started_at"),
  // The pinned crew Telegram message's id — captured on go-live so the on→off
  // transition can unpin it. Null when nothing is pinned.
  tgMessageId: integer("tg_message_id"),
  // The stream title, when live (public Twitch metadata). Null when offline.
  title: text("title"),
  // When this row was last refreshed by the poller (ISO) — the staleness anchor
  // the read-side auto-clear measures against.
  updatedAt: text("updated_at").notNull(),
});

// An append-only per-step COST ledger (COST-01) — one row per billable unit of
// work spent on a finding (or a non-finding step). Sibling of
// serviceCheckSamples / statusEvents: id PK + occurred_at time index + query keys
// indexed. NEVER pruned (full history is the point; volume is trivial — dozens of
// rows/day). Written two ways: Worker-local insertCostEvents() for Worker-side
// vendor calls, and the agent-tier record_cost POST for box-side numbers (the
// record_health precedent, MADE IDEMPOTENT — see id).
//
// costBasis is the load-bearing axis: `cash` = real incremental money (the
// headline "cost per finding" sums THIS only); `subsidized` = a resource draw
// under a fixed plan (subscription LLM tokens + on-box compute) — shown as
// usage/proportion, NEVER summed into the cash total. source is the ORTHOGONAL
// quantity-confidence: `measured` (a real usage number / timestamp diff) vs
// `estimated` (a rate×count heuristic, incl. the one-time backfill).
//
// The enum-ish columns are plain TEXT with an inline `enum` that only NARROWS the
// TS type — widening the vendor/step list needs ZERO DDL (the serviceCheckSamples
// idiom).
export const costEvents = sqliteTable(
  "cost_events",
  {
    costBasis: text("cost_basis", { enum: ["cash", "subsidized"] }).notNull(),
    // ISO write time — kept DISTINCT from occurred_at because a box row's spend
    // time (occurred_at) precedes its Worker write time under clock skew / retry.
    createdAt: text("created_at").notNull(),
    // NULLABLE on purpose: a rate-miss (unknown vendor/unit) must surface as
    // "—/unpriced", never launder to $0 (indistinguishable from a genuinely-free
    // row). cash: real $; subsidized: API-equivalent / allocated (never summed
    // into cash); null: unpriced.
    estimatedUsd: real("estimated_usd"),
    // A client-generated STABLE id = the idempotency key. Emitters build a
    // deterministic key (e.g. `${step}:${logId ?? trackId ?? "global"}:${vendor}:${unitType}:${occurredAt}`)
    // so a retried best-effort POST re-inserts the SAME id and is ignored (INSERT
    // … ON CONFLICT(id) DO NOTHING) — an append-only ledger with a retried write
    // DOUBLE-COUNTS without this.
    id: text("id").primaryKey(),
    logId: text("log_id"), // Log ID snapshot (coordinate-first read); NULL for non-finding steps
    model: text("model"), // e.g. claude-sonnet-4-6 (from modelUsage, never assumed); NULL for non-LLM rows
    occurredAt: text("occurred_at").notNull(), // ISO when the work was spent
    // total tokens / characters / seconds / requests (the step's natural unit;
    // real, since seconds/chars can be fractional).
    quantity: real("quantity").notNull(),
    source: text("source", { enum: ["measured", "estimated"] }).notNull(),
    step: text("step", {
      enum: [
        "enrich",
        "embed",
        "context",
        "observe",
        "note",
        "bio",
        "video",
        "publish",
        "discogs",
        "lastfm",
        "newsletter",
        "studio-clip",
        "cluster",
        // The only step that is not per-finding pipeline work: the search resolver's
        // language→filters LLM call (lib/server/search-llm.ts). It carries no log_id/
        // track_id (a search is not about one track), which the ledger already allows.
        "search",
      ],
    }).notNull(),
    // finding id (no declared FK — socialPosts.trackId / user_galaxy_collections
    // precedent); NULL for non-finding steps.
    trackId: text("track_id"),
    unitType: text("unit_type", {
      enum: ["tokens", "characters", "seconds", "requests", "emails"],
    }).notNull(),
    vendor: text("vendor", {
      enum: ["anthropic", "openrouter", "cartesia", "firecrawl", "apify", "resend", "self"],
    }).notNull(), // "self" = on-box compute (no invoice → subsidized)
  },
  (table) => [
    // Index the QUERY SHAPE, not every column. The two aggregations group by step /
    // track_id and window by occurred_at; a plain occurred_at serves the global
    // window. No vendor index (nothing groups by vendor).
    index("cost_events_step_occurred_at_idx").on(table.step, table.occurredAt),
    index("cost_events_track_id_occurred_at_idx").on(table.trackId, table.occurredAt),
    index("cost_events_occurred_at_idx").on(table.occurredAt),
  ],
);

// The public REACH snapshot ledger — one append-only row per (platform, metric)
// per day: how far Fluncle's tentacles reach across the web, over time. Sibling of
// serviceCheckSamples / costEvents (id PK + a time-indexed query shape), and the
// noun-swap of the record_health discipline: a daily on-box trigger fires the
// agent-tier record_platform_stats op, the Worker fetches each platform with the
// auth it already holds, and one snapshot row lands per number. NEVER pruned — the
// series IS the point (the day-one row is the genesis baseline), and daily × ~14
// metrics is trivial volume.
//
// `platform`/`metric` are plain TEXT so a NEW platform (or a new metric on one) is
// a data row, never a migration — exactly the serviceCheckSamples idiom. The
// standardization taxonomy (audience / reach / depth buckets) is NOT stored: the
// rows stay raw and the page decides how to group them.
//
// PUBLIC-SAFE by construction: every number here is already public on its own
// platform (a follower count, a star count, a play count), so nothing sensitive
// ever lives in this table.
export const platformStats = sqliteTable(
  "platform_stats",
  {
    // ISO instant the snapshot was collected. The series' x-axis; one point per day.
    capturedAt: text("captured_at").notNull(),
    // The client-STABLE idempotency key: `${platform}:${metric}:${yyyy-mm-dd}` (the
    // day derived from the collection `at`). A second collect on the same UTC day
    // re-inserts the SAME id and is ignored (INSERT … ON CONFLICT(id) DO NOTHING),
    // so the daily snapshot is idempotent — the record_cost discipline.
    id: text("id").primaryKey(),
    // The measured number (followers / listens / stars / subscribers / …). Always a
    // non-negative integer count; no fractional platform metric exists in Tier 1.
    metric: text("metric").notNull(),
    // The platform this metric belongs to (mixcloud / bluesky / github / npm /
    // lastfm / appstore / telegram / newsletter / spotify_playlist / youtube). Plain
    // TEXT — a new platform needs no DDL.
    platform: text("platform").notNull(),
    value: integer("value").notNull(),
  },
  (table) => [
    // The page read groups by (platform, metric) and windows by captured_at (last N
    // days), so one composite index serves both the grouping and the bounded window.
    index("platform_stats_platform_metric_captured_at_idx").on(
      table.platform,
      table.metric,
      table.capturedAt,
    ),
  ],
);

// THE CATALOGUE FUNNEL LEDGER — one row per UTC day, the growth history behind the
// /admin/funnel page (docs/rfcs/catalogue-funnel-rfc.md, U1). Live counts are cheap; the
// growth-per-day charts need history nobody records (there is no `anchored_at`, no per-day
// ledger), so this is the `platform_stats` daily-snapshot pattern applied to the catalogue
// pipeline: a daily on-box trigger fires the agent-tier `record_catalogue_snapshot` op, the
// Worker computes every stage total + queue depth + frontier count (all through the SAME
// predicates the sweeps run — lib/server/funnel.ts, so the funnel can never drift from the
// real gates), and one row lands per day.
//
// `day` (UTC yyyy-mm-dd) is the PRIMARY KEY, so the daily snapshot is UNIQUE + idempotent by
// construction: a re-fired tick the same day is one `insert … on conflict(day) do update`
// that OVERWRITES the row with fresh counts, never doubling a bar. Every count is an integer.
//
// NO backfill: the series starts with the first real snapshot and grows honestly (invented
// history is worse than a short chart). NEVER pruned — the series IS the point.
//
// The series read is a plain ASC index walk on the `day` PK (`where day >= ? order by day
// asc`), a lexicographic-equals-chronological window — no `desc()` index (the ratified trap).
export const catalogueSnapshots = sqliteTable("catalogue_snapshots", {
  // Queue depth — the `analyze` worklist backlog (track-work.ts `kindClause`), catalogue half.
  analyzeQueue: integer("analyze_queue").notNull(),
  // Stage total — uncertified catalogue rows carrying full-song analysis (bpm/key from the audio).
  analyzed: integer("analyzed").notNull(),
  // Queue depth — the anchor worklist's re-ask BENCH: rows that WOULD be anchorable but were
  // attempted inside the 14-day re-ask window, so they sit out (not re-billed) for now.
  anchorBackoff: integer("anchor_backoff").notNull(),
  // Queue depth — anchor worklist rows WITH an ISRC (the exact-ISRC anchor path).
  anchorQueueIsrc: integer("anchor_queue_isrc").notNull(),
  // Queue depth — anchor worklist rows with NO ISRC (the search-triple anchor path).
  anchorQueueNoIsrc: integer("anchor_queue_no_isrc").notNull(),
  // Stage total — uncertified catalogue rows that have gained a Spotify anchor (`spotify_uri`).
  anchored: integer("anchored").notNull(),
  // Queue depth — the `capture` worklist backlog (catalogue half). Reflects the capture BRAKE:
  // a shut budget narrows the catalogue capture queue to 0 (the budget meter says why).
  captureQueue: integer("capture_queue").notNull(),
  // Stage total — uncertified catalogue rows whose full-song audio has been captured.
  captured: integer("captured").notNull(),
  // Stage total — CERTIFIED tracks (a `findings` row exists). The right edge of the funnel:
  // the catalogue → archive exit is a number.
  certified: integer("certified").notNull(),
  // Stage total — CRAWLED / uncertified: every catalogue track (a `tracks` row with no
  // `findings` row). The funnel's left edge.
  crawled: integer("crawled").notNull(),
  createdAt: text("created_at").notNull(),
  // The UTC day (yyyy-mm-dd) this snapshot covers. PK ⇒ one row per day, idempotent upsert.
  day: text("day").primaryKey(),
  // Queue depth — the `embed` worklist backlog (catalogue half).
  embedQueue: integer("embed_queue").notNull(),
  // Stage total — uncertified catalogue rows carrying a MuQ embedding vector.
  embedded: integer("embedded").notNull(),
  // Frontier — crawl_frontier nodes fully drained (`done`).
  frontierDone: integer("frontier_done").notNull(),
  // Frontier — crawl_frontier nodes still waiting (`pending`); 0 means the reachable graph is drained.
  frontierPending: integer("frontier_pending").notNull(),
  // Stage total — the rec-eligibility pool: uncertified rows that clear the EXACT gate
  // `listRecommendations` scans by (the shared `REC_ELIGIBLE_WHERE`, lib/server/recommendations.ts).
  recEligible: integer("rec_eligible").notNull(),
});

export const spotifyAuth = sqliteTable("spotify_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// Our own YouTube OAuth for mixtape video distribution — same shape as
// spotify_auth. The Worker holds the durable refresh token here and mints a
// short-lived access token for the CLI's resumable upload PUT + the server-side
// unlisted→public flip (videos.update). Single row, service PK = "youtube".
export const youtubeAuth = sqliteTable("youtube_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// Our own Mixcloud OAuth for mixtape audio distribution — kept server-side like
// spotify_auth / youtube_auth (the CLI stays a thin client). Mixcloud tokens don't
// expire and there's no refresh token, so the table is just the durable access
// token; the Worker hands it to the CLI just-in-time for the direct upload (the
// bytes are CLI-direct; the credential is not). Single row, service PK = "mixcloud".
export const mixcloudAuth = sqliteTable("mixcloud_auth", {
  accessToken: text("access_token").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// The /reach Tier-2 OAuth token stores (docs/reach-tier2-activation.md), one row per
// platform — the same shape as spotify_auth / youtube_auth (the CLI/box never holds the
// durable credential; the Worker mints an access token on demand). DORMANT until the
// operator connects each: the reach collector skips a platform whose row is absent.

// Twitch — the broadcaster's OWN user token + refresh, for the Helix follower total
// (moderator:read:followers). Access token ~4h; refreshed via the stored refresh token.
// Single row, service PK = "twitch".
export const twitchAuth = sqliteTable("twitch_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  scope: text("scope").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

// Instagram — the "Instagram API with Instagram Login" LONG-LIVED token (60 days) for
// followers_count. There is NO refresh_token: the token itself is refreshed in place
// (graph.instagram.com/refresh_access_token), so this table has no refresh column and
// no scope column, just the durable token + its expiry. Single row, service PK =
// "instagram".
export const instagramAuth = sqliteTable("instagram_auth", {
  accessToken: text("access_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  service: text("service").primaryKey(),
  updatedAt: text("updated_at").notNull(),
});

export const submissions = sqliteTable(
  "submissions",
  {
    album: text("album"),
    artistsJson: text("artists_json").notNull(),
    artworkUrl: text("artwork_url"),
    contact: text("contact"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    note: text("note"),
    reviewedAt: text("reviewed_at"),
    source: text("source", { enum: ["web", "cli", "ssh"] }).notNull(),
    spotifyTrackId: text("spotify_track_id").notNull(),
    spotifyUrl: text("spotify_url").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    submitterHash: text("submitter_hash").notNull(),
    title: text("title").notNull(),
    // PROVENANCE — the `triage_verdict` prompt version the verdict below was phrased
    // under (docs/agents/prompt-registry.md). NULL when the sweep fell back to its
    // baked-in default (or never visited); `0` is the registry default; a number is the
    // live `prompt_versions.version`.
    triagePromptVersion: integer("triage_prompt_version"),
    // The pre-chew triage verdict — a short one-line "looks like a find / already
    // logged / not our lane" read the on-box `fluncle-triage` sweep authors for a
    // pending submission before the operator gets to it. Operator-internal (never
    // public), advisory only: approve/reject authority never moves. NULL until the
    // sweep visits (or forever, if the sweep is not installed).
    triageVerdict: text("triage_verdict"),
    userId: text("user_id"),
  },
  (table) => [
    index("submissions_status_created_at_idx").on(table.status, table.createdAt),
    index("submissions_spotify_track_id_idx").on(table.spotifyTrackId),
    index("submissions_submitter_hash_created_at_idx").on(table.submitterHash, table.createdAt),
    index("submissions_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

export const user = sqliteTable("user", {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  // The crew number — the account's enlistment ordinal on the manifest (the
  // account-redesign brief, ruling #1). A stamped `№007` position in join order,
  // deliberately NOT coordinate-shaped (a crew member is not certified music), fixed
  // for life. NULLABLE + UNIQUE: SQLite lets many rows carry NULL under a UNIQUE
  // index, so an unstamped row (a legacy user before the backfill, or the instant
  // between the better-auth insert and the `user.create.after` assignment) coexists
  // with the unique numbers. Assigned atomically by `assignCrewNumber` (public-auth.ts)
  // as `max(crew_number) + 1`; backfilled for existing users by the one-time
  // `scripts/backfill-crew-numbers.ts`.
  crewNumber: integer("crew_number").unique(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  displayUsername: text("display_username"),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended", "deleted"] })
    .default("active")
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  username: text("username").unique(),
});

export const session = sqliteTable(
  "session",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// The OAuth 2.0 Device Authorization Grant ledger (RFC 8628) — Better Auth's
// `deviceAuthorization` plugin model. One row per `fluncle login`: minted on
// /api/auth/device/code (status "pending"), flipped to "approved"/"denied" when
// the user acts at /device, and consumed when the CLI exchanges the device code
// for a session at /api/auth/device/token. Rows expire (`expiresAt`) and the
// plugin sweeps them. Column names are snake_case to match the rest of the auth
// schema; the Better Auth model name is `deviceCode`.
export const deviceCode = sqliteTable(
  "device_code",
  {
    clientId: text("client_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    deviceCode: text("device_code").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
    pollingInterval: integer("polling_interval"),
    scope: text("scope"),
    status: text("status").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("device_code_device_code_idx").on(table.deviceCode),
    index("device_code_user_code_idx").on(table.userCode),
  ],
);

export const rateLimitEvents = sqliteTable(
  "rate_limit_events",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    userId: text("user_id"),
  },
  (table) => [
    index("rate_limit_action_bucket_created_at_idx").on(
      table.action,
      table.bucket,
      table.createdAt,
    ),
    index("rate_limit_user_action_created_at_idx").on(table.userId, table.action, table.createdAt),
    index("rate_limit_ip_action_created_at_idx").on(table.ipHash, table.action, table.createdAt),
  ],
);

// Fixed-window rate-limit counters: one row per (action, bucket, window_start),
// incremented by a single atomic conditional upsert (see lib/server/rate-limit.ts).
// This is the durable, race-free backbone for every action limiter — the
// `count < max` guard lives in the upsert's `WHERE`, so two concurrent requests
// can never both pass the limit (unlike the old count-then-insert TOCTOU path).
// The `bucket` is `hash(cf-connecting-ip)` for anonymous callers or `userId` for
// authenticated ones — never the spoofable x-forwarded-for, never the User-Agent.
export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    action: text("action").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),
    // ISO timestamp of the start of the current fixed window (windowMs-aligned).
    windowStart: text("window_start").notNull(),
  },
  (table) => [
    uniqueIndex("rate_limit_counter_action_bucket_window_idx").on(
      table.action,
      table.bucket,
      table.windowStart,
    ),
  ],
);

export const userGalaxyState = sqliteTable("user_galaxy_state", {
  createdAt: text("created_at").notNull(),
  deaths: integer("deaths").notNull().default(0),
  lastPlayedAt: text("last_played_at"),
  schemaVersion: integer("schema_version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id").primaryKey(),
  wins: integer("wins").notNull().default(0),
});

export const userGalaxyCollections = sqliteTable(
  "user_galaxy_collections",
  {
    firstCollectedAt: text("first_collected_at").notNull(),
    id: text("id").primaryKey(),
    lastCollectedAt: text("last_collected_at").notNull(),
    logId: text("log_id").notNull(),
    sourceSurface: text("source_surface", { enum: ["web", "cli", "ssh", "mcp"] }).notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    uniqueIndex("user_galaxy_collections_user_track_idx").on(table.userId, table.trackId),
    index("user_galaxy_collections_user_first_idx").on(table.userId, table.firstCollectedAt),
    index("user_galaxy_collections_track_first_idx").on(table.trackId, table.firstCollectedAt),
  ],
);

// A signed-in user's recommendation SEEDS — the ≤12 tracks their personal
// telescope points from (the per-user recommendation engine, docs/the-ear.md
// § The per-user telescopes). A seed references ANY `tracks` row — a certified
// finding or an uncertified catalogue track — because a listener seeds with what
// they like, not with what Fluncle certified. The (user_id, track_id) PRIMARY KEY
// is the natural identity (a track is a seed once per user; re-adding refreshes
// `added_at`), and the `user_id` index serves the per-user reads (the seed list +
// the seed-vector probe read, both bounded by the 12-seed cap — enforced in the
// op, not the schema: SQLite has no per-group row cap). Like every sibling
// per-user table, `user_id` is a logical FK (no SQL cascade) — deletion is
// application-code (`accountDeletionStatements`), never a constraint.
export const userRecSeeds = sqliteTable(
  "user_rec_seeds",
  {
    addedAt: text("added_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.trackId] }),
    index("user_rec_seeds_user_idx").on(table.userId),
  ],
);

// A signed-in user's ONE public Spotify playlist — "Fluncle's Frontier" (E2, the
// public recommendation machine). It lives on FLUNCLE'S OWN Spotify account (no
// per-user OAuth, so the dev-mode 5-user allow-list cap never applies), holds the
// user's current recommendations (the E1 blend), and is refreshed weekly. ONE row
// per user (the `user_id` primary key): the playlist is created once and mirrored
// thereafter, never a second one.
//
//   - `playlist_id`      — the Spotify playlist id, minted once by the first sync.
//   - `created_at`       — when the playlist was minted (the rolling daily MINT-cap
//                          window reads this: `count(created_at >= now-24h)`).
//   - `last_synced_at`   — the last successful item PUT (null until the first sync
//                          lands), so `/me` can say when the Frontier last moved.
//   - `last_uri_hash`    — the sha256 of the last URI list the mirror PUT (the
//                          telescope's `last_mirror` change-detector, per-row): an
//                          unchanged list skips the PUT, so a weekly refresh that
//                          finds nothing new is one read, not a needless write.
//   - `cover_uploaded_at`— when the custom cover last landed on Spotify, or NULL. The
//                          cover is a NODE-SIDE render leg (Remotion can't run in the
//                          Worker), keyed on `cover_uploaded_at IS NULL`; it stays
//                          INERT until the operator re-auths with `ugc-image-upload`.
//
// `user_id` is a logical FK (no SQL cascade), matching every sibling per-user table —
// deletion is application-code (accountDeletionStatements), never a constraint.
export const userFrontierPlaylists = sqliteTable("user_frontier_playlists", {
  coverUploadedAt: text("cover_uploaded_at"),
  createdAt: text("created_at").notNull(),
  lastSyncedAt: text("last_synced_at"),
  lastUriHash: text("last_uri_hash"),
  playlistId: text("playlist_id").notNull(),
  userId: text("user_id").primaryKey(),
});

// A user's FRONTIER EDITIONS — one FROZEN snapshot per real weekly refresh of their
// Frontier playlist, read two ways: (a) the NOVELTY LEDGER the engine re-derives its
// last-N-editions exclusion set from (so the weekly playlist rotates), and (b) the
// HISTORY the "past editions" dropdown/dialog reads for track recovery. Modeled on the
// `mixtapes` + `mixtape_tracks` frozen-snapshot precedent (child rows, not a JSON column
// — novelty is then a plain indexed join, no per-row `json_each` hosted trap).
//
// `user_id` is a logical FK (no SQL cascade), matching every sibling per-user table —
// deletion is application-code (`accountDeletionStatements`), never a constraint.
// `number` is per-user monotonic (`coalesce(max(number),0)+1`), and is the ONE name
// used everywhere (column, DTO, path param). No status/uri_hash/playlist_id/iso_*
// columns: nothing reads them — the date label derives its civil date from `created_at`.
//
// `seeds_used`/`seeds_skipped_json` FREEZE the engine's seed accounting at write time so
// the shelf's honesty strings ("these two picks aren't steering yet") survive the freeze
// without a re-run of the engine on a read (the shelf reads the edition, never the scan).
// Both are NULLABLE: a pre-migration edition cannot back them, and the surface degrades to
// omitting what it cannot honestly say (the Readout Rule's honest absence).
export const frontierEditions = sqliteTable(
  "frontier_editions",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    seedsSkippedJson: text("seeds_skipped_json"),
    seedsUsed: integer("seeds_used"),
    userId: text("user_id").notNull(),
  },
  (table) => [
    // The `(user_id, number)` btree serves every read: it bounds the last-8 novelty
    // derive to one user, and SQLite walks it in REVERSE for the newest-first dropdown
    // and the derive's `order by number desc limit N` — a dedicated DESC index would be
    // redundant (and drizzle-kit's turso dialect cannot round-trip a `desc()` index
    // expression through a later column ALTER, so it must not exist).
    uniqueIndex("frontier_editions_user_number_idx").on(table.userId, table.number),
  ],
);

// A frontier edition's FROZEN tracklist — the de-duped PUT order the playlist actually
// sent (A2). `track_id` is the id novelty excludes on and the id the Save action files.
// `log_id` is set only for certified-finding slots (the unnamed catalogue tier stays
// unnamed). `title_text`/`artists_text` mirror `mixtape_tracks` naming; the readouts
// (`bpm`/`key`/`duration_ms`) are frozen so the dialog renders the chips without a JOIN.
// `slot` drives the UI register split (finding vs catalogue). `similarity` FREEZES the
// engine's honest max-similarity for the row (the shelf displays the number and the
// readout chips) — NULLABLE, so a pre-migration edition degrades to omitting it.
export const frontierEditionTracks = sqliteTable(
  "frontier_edition_tracks",
  {
    artistsText: text("artists_text").notNull(),
    bpm: integer("bpm"),
    coverUrl: text("cover_url"),
    durationMs: integer("duration_ms"),
    editionId: text("edition_id").notNull(),
    key: text("key"),
    logId: text("log_id"),
    position: integer("position").notNull(),
    similarity: real("similarity"),
    slot: text("slot", { enum: ["finding", "catalogue"] }).notNull(),
    spotifyUri: text("spotify_uri"),
    spotifyUrl: text("spotify_url"),
    titleText: text("title_text").notNull(),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    uniqueIndex("frontier_edition_tracks_edition_position_idx").on(table.editionId, table.position),
    index("frontier_edition_tracks_edition_id_idx").on(table.editionId),
  ],
);

// A signed-in user's saved tracks. `track_id` is the identity a save files against
// (the unique key with `user_id`); `log_id` is the certified finding's coordinate,
// present ONLY when the saved track IS a finding — an uncertified catalogue track
// saves with a null `log_id` (the unlit tier stays unnamed). The `user_saved_findings`
// name is a legacy artifact from the findings-only era; the list now holds any track,
// and a later pass may rename it to `user_saved_tracks`.
export const userSavedFindings = sqliteTable(
  "user_saved_findings",
  {
    id: text("id").primaryKey(),
    logId: text("log_id"),
    note: text("note"),
    savedAt: text("saved_at").notNull(),
    trackId: text("track_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [uniqueIndex("user_saved_findings_user_track_idx").on(table.userId, table.trackId)],
);

// A signed-in user's saved `/mix` sets — the account-backed home for a chained
// set. `/mix` stays fully usable anonymous (the set + taste live in the URL, the
// wire format); signing in only SAVES a chain so it survives the tab. `set_tokens`
// is the serialized `?set=` chain stored VERBATIM (same codec the route uses), and
// `taste` the serialized `?taste=` seed, so opening a saved set round-trips through
// the exact serializer that wrote it. There is no natural unique key (a user may
// keep two differently-named sets of the same tracks), so the row `id` is the
// identity; the index serves the newest-first list. `user_id` is a logical FK (no
// SQL cascade), matching every sibling per-user table — deletion is application-code
// (accountDeletionStatements), never a constraint.
export const userSavedSets = sqliteTable(
  "user_saved_sets",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    setTokens: text("set_tokens").notNull(),
    taste: text("taste"),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("user_saved_sets_user_updated_idx").on(table.userId, table.updatedAt)],
);

// A signed-in user's WATCHED entities — the artists and labels they asked to keep an eye
// on. The saved-sets sibling exactly (a per-user list keyed by the Better Auth user, a
// logical FK with no SQL cascade — deletion is application code in
// `accountDeletionStatements`, never a constraint). THE ACCOUNT NEVER GATES THE FEATURE:
// a signed-out visitor sees no watch control at all (the control simply does not render,
// the SaveSetDialog precedent), and the per-entity fresh feeds (`/artist/<slug>/fresh.xml`)
// stay the anonymous watcher equivalent, untouched.
//
// `kind` + `entity_id` point at the `artists.id` / `labels.id` this watch is for — resolved
// by ID at write time and stored WITHOUT any denormalized name/slug (the entity's own row
// stays the source of truth; the account list joins for the display name at read time). The
// UNIQUE on (user_id, kind, entity_id) makes watching twice idempotent — a second watch of
// the same entity upserts rather than duplicating.
//
// `include_similar` is HEADROOM with no consumer yet: the deferred email digest (operator
// deferral 2026-07-19) will read it to decide whether a watch also pulls in sonically-near
// entities. It defaults OFF in storage and has no UI — nothing writes anything but the
// default today. Do not build a control for it until the digest lands.
export const userWatches = sqliteTable(
  "user_watches",
  {
    createdAt: text("created_at").notNull(),
    entityId: text("entity_id").notNull(),
    id: text("id").primaryKey(),
    includeSimilar: integer("include_similar", { mode: "boolean" }).notNull().default(false),
    kind: text("kind", { enum: ["artist", "label"] }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    // Watching twice is a no-op, not a duplicate row — the save path upserts on this key.
    uniqueIndex("user_watches_user_kind_entity_idx").on(table.userId, table.kind, table.entityId),
    // The `/account` list read: `where user_id = ? order by created_at desc`. A plain ASC
    // btree (SQLite reverse-scans it) — never a `desc()` index, which poisons the drizzle
    // snapshot into rebuilding every index on the next migration (the ratified trap).
    index("user_watches_user_created_idx").on(table.userId, table.createdAt),
  ],
);

// A signed-in user's cross-device preferences — the account-backed home for a
// setting that today lives device-local (the Scales/Camelot key-notation choice in
// localStorage). ONE row per user (the `user_id` primary key), holding a single
// zod-validated JSON `preferences` blob. This is the FIRST user preference, not the
// last: a new preference extends the shared zod object (`UserPreferencesSchema` in
// `@fluncle/contracts/orpc`) + its consumers, never this schema — the column is a
// closed object, so growing it needs no migration. THE ACCOUNT NEVER GATES A
// FEATURE: an anonymous visitor keeps the device-local toggle exactly as before;
// this row only carries the choice ACROSS devices when signed in. `user_id` is a
// logical FK (no SQL cascade), matching every sibling per-user table — deletion is
// application-code (`accountDeletionStatements`), never a constraint, because the
// deletion flow ANONYMIZES the user row rather than dropping it, so a SQL cascade
// would never fire.
export const userPreferences = sqliteTable("user_preferences", {
  preferences: text("preferences").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id").primaryKey(),
});

export const userDataExports = sqliteTable(
  "user_data_exports",
  {
    completedAt: text("completed_at"),
    expiresAt: text("expires_at").notNull(),
    id: text("id").primaryKey(),
    r2Key: text("r2_key"),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [index("user_data_exports_user_requested_idx").on(table.userId, table.requestedAt)],
);

export const userDeletionRequests = sqliteTable(
  "user_deletion_requests",
  {
    completedAt: text("completed_at"),
    id: text("id").primaryKey(),
    mode: text("mode", { enum: ["delete"] }).notNull(),
    requestedAt: text("requested_at").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    summaryJson: text("summary_json").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("user_deletion_requests_user_requested_idx").on(table.userId, table.requestedAt),
  ],
);

// Per-platform publication state for a track's video. One row per (track,
// platform); the generic track pipeline tops out at "video in R2" (video_url),
// and publication is tracked here. Today: TikTok via Postiz (push draft → manual
// review/publish in-app → status updated by the operator) and YouTube Shorts
// (direct PUBLIC upload → `published`; the public `url` is auto-recorded from
// Postiz `/missing`, falling back to the operator's manual entry). The `platform`
// enum is plain TEXT, so widening it (e.g. to Instagram Reels) needs no migration.
// `external_id` holds the Postiz post id; `url` the public post URL.
export const socialPosts = sqliteTable(
  "social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["tiktok", "youtube"] }).notNull(),
    publishedAt: text("published_at"),
    scheduledFor: text("scheduled_for"),
    status: text("status", { enum: ["draft", "scheduled", "published", "failed"] }).notNull(),
    trackId: text("track_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [uniqueIndex("social_posts_track_platform_idx").on(table.trackId, table.platform)],
);

// THE SOCIAL-METRICS LEDGER — append-only per-post performance snapshots, one row per
// (post × source × captured day). The `platform_stats` daily-snapshot pattern applied to a
// finding's INDIVIDUAL posts: `platform_stats` counts the whole channel (followers, total likes),
// this counts each posted video's own reach, so per-video velocity (day-over-day deltas) becomes
// measurable. A daily on-box trigger fires the agent-tier `record_social_metrics` op; the Worker
// reads each published `social_posts` row's Postiz per-post analytics and APPENDS today's numbers.
//
// APPEND-ONLY BY DESIGN — never an upsert-latest: velocity matters, so the series keeps every day's
// snapshot rather than overwriting a single "latest" row. Idempotence is per-DAY, not per-write:
// the `(external_id, source, captured_day)` unique index means a second run the same UTC day is a
// no-op (INSERT … ON CONFLICT DO NOTHING), so a re-fired tick never doubles a day's point.
//
// `captured_day` (UTC yyyy-mm-dd, derived from `captured_at` at write time) is stored as its own
// column so the idempotency index is a plain btree — a SQLite unique index can't span an expression,
// and deriving the day in SQL at index time is exactly what libSQL won't do. Every metric column is
// NULLABLE: Postiz returns a platform-dependent subset of labels, so an absent metric is null (never
// zero — a real zero and "the platform didn't report it" must stay distinguishable).
export const socialMetrics = sqliteTable(
  "social_metrics",
  {
    // Average % of the video watched (0–100), a real — the only fractional metric. Null when unreported.
    averageViewPercentage: real("average_view_percentage"),
    // The ISO instant this snapshot was taken. The series' fine-grained x-axis.
    capturedAt: text("captured_at").notNull(),
    // The UTC day (yyyy-mm-dd) derived from `captured_at`. The idempotency key's day component:
    // one snapshot per (post, source) per day. A plain column so the unique index below is a btree.
    capturedDay: text("captured_day").notNull(),
    comments: integer("comments"),
    createdAt: text("created_at").notNull(),
    // The Postiz post id (`social_posts.external_id`) this snapshot measures. The join back to the post.
    externalId: text("external_id").notNull(),
    id: text("id").primaryKey(),
    impressions: integer("impressions"),
    likes: integer("likes"),
    // The platform the post lives on. Plain TEXT with an enum narrow (a new platform needs no DDL).
    platform: text("platform", { enum: ["tiktok", "youtube"] }).notNull(),
    saves: integer("saves"),
    shares: integer("shares"),
    // Where the numbers came from. `postiz` today; room for `youtube_analytics` / `tiktok_display` /
    // `csv` later without a migration — the source is part of the idempotency key, so two sources can
    // snapshot the same post on the same day without colliding.
    source: text("source", { enum: ["postiz", "youtube_analytics", "tiktok_display", "csv"] })
      .notNull()
      .default("postiz"),
    // The finding this post belongs to (`social_posts.track_id` → `findings.track_id`). Denormalised
    // onto the row so a per-finding read never has to re-join `social_posts`. No declared FK (this
    // schema declares none).
    trackId: text("track_id").notNull(),
    views: integer("views"),
    // Watch time in whole seconds. Null when unreported.
    watchTimeSeconds: integer("watch_time_seconds"),
  },
  (table) => [
    // The idempotency guard: one snapshot per (post, source, UTC day). The daily INSERT … ON
    // CONFLICT DO NOTHING keys on this, so a re-fired tick never doubles a day's point.
    uniqueIndex("social_metrics_external_source_day_idx").on(
      table.externalId,
      table.source,
      table.capturedDay,
    ),
    // The per-finding series read (a finding's posts over time), a plain ASC walk — no desc() index
    // (the ratified drizzle-kit turso trap); readers order in the query.
    index("social_metrics_track_captured_at_idx").on(table.trackId, table.capturedAt),
  ],
);

// Distribution links no longer live here — they are the single source of truth in
// `mixtape_social_posts` (one row per platform, with status + external_id). The
// public DTO's `externalUrls` is derived from the published rows via a subquery in
// MIXTAPE_SELECT; nothing is dual-written onto the mixtape row.
export const mixtapes = sqliteTable(
  "mixtapes",
  {
    addedAt: text("added_at"),
    // When set (an ISO timestamp), the mixtape has been announced to the crew (the
    // Telegram crew channel), so `announce_mixtape` won't double-post. A one-shot
    // marker, filled by the operator-tier announce op the moment the post lands
    // (released back to NULL only if the Telegram send fails, so a retry works).
    announcedAt: text("announced_at"),
    createdAt: text("created_at").notNull(),
    durationMs: integer("duration_ms"),
    id: text("id").primaryKey(),
    logId: text("log_id").unique(),
    note: text("note"),
    // `planned_for` moved to the PLAN (`recordings.planned_for`) in the
    // plan→recording→mixtape Deploy-2 cutover (RFC §6, D-plannedFor): upcoming live
    // sessions are plans now, and `/calendar.ics` reads them there.
    publishedAt: text("published_at"),
    recordedAt: text("recorded_at"),
    // The `recordings` row this mixtape was PROMOTED from (RFC recording-primitive,
    // Design B). Nullable: a mixtape born the old way (minted directly) has none;
    // set only when `promote` links a coordinate-less recording to this mixtape.
    // Plain text id, no declared FK — this schema declares none. ADDED beside the
    // existing columns (SQLite ADD COLUMN can't be NOT NULL without a default;
    // pre-existing rows carry NULL).
    recordingId: text("recording_id"),
    sequenceNumber: integer("sequence_number").unique(),
    // When set (an ISO timestamp), the full set video has been uploaded to R2 at
    // `<log-id>/set.mp4` and the mixtape `/log` page shows the branded scrubber
    // player. Operator-flipped from /admin/mixtapes AFTER the upload; null until
    // then. A flag, not a URL — the URL derives from the Log ID (mixtapeSetVideoUrl).
    setVideoAt: text("set_video_at"),
    // "distributing" is the minted-but-uploading state before published (see
    // MixtapeStatus in @fluncle/contracts). Plain TEXT, the enum only narrows the
    // type — there is no "draft": a mixtape is only ever born via
    // `promote_recording`, whose claim inserts `distributing` explicitly (unminted
    // while `log_id` is null). The raw-SQL `'draft'` default is vestigial and kept
    // byte-identical so the narrow emits ZERO DDL (RFC §9/SF-4: no insert relies
    // on the default; changing it would rebuild the table for nothing).
    status: text("status", { enum: ["distributing", "published"] })
      .notNull()
      .default(sql`'draft'`),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("mixtapes_recording_id_idx").on(table.recordingId)],
);

// Per-platform distribution state for a mixtape's audio/video, mirroring
// `social_posts` for findings: one row per (mixtape, platform). This is the SINGLE
// source of truth for a mixtape's listen links — the public DTO's `externalUrls`
// derives from the `published` rows here (no `mixtapes.*_url` columns). YouTube +
// Mixcloud are recorded by the CLI `distribute` flow (it moves the multi-GB bytes
// the Worker can't proxy); SoundCloud is set manually from the admin editor.
// `external_id` holds the YouTube videoId / Mixcloud cloudcast key; `url` the
// public URL.
export const mixtapeSocialPosts = sqliteTable(
  "mixtape_social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"),
    id: text("id").primaryKey(),
    mixtapeId: text("mixtape_id").notNull(),
    platform: text("platform", { enum: ["youtube", "mixcloud", "soundcloud"] }).notNull(),
    publishedAt: text("published_at"),
    status: text("status", { enum: ["uploading", "published", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [
    uniqueIndex("mixtape_social_posts_mixtape_platform_idx").on(table.mixtapeId, table.platform),
  ],
);

// Push-notification device registry (the mobile app):
// one row per Expo push token, which IS the natural key (the `userGalaxyState`
// natural-PK precedent, not a surrogate id). `token` is `ExponentPushToken[…]`;
// `userId` is nullable — the V1 app is anonymous, so it binds only once accounts
// arrive (a future "linked to user" privacy-label flip). `mutedJson` is a TEXT
// JSON array of muted categories (the `tracks.features_json` JSON-column
// precedent), e.g. `["mixtapes"]`. `lastSeenAt` is bumped on every re-register so
// a staleness reaper can prune long-dead anonymous rows. The send module reads
// this table; the GDPR sweep (account-data.ts) clears a deleted user's tokens.
export const pushTokens = sqliteTable(
  "push_tokens",
  {
    appVersion: text("app_version"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    mutedJson: text("muted_json"),
    platform: text("platform", { enum: ["android", "ios"] }).notNull(),
    token: text("token").primaryKey(),
    userId: text("user_id"),
  },
  (table) => [
    index("push_tokens_user_id_idx").on(table.userId),
    index("push_tokens_last_seen_at_idx").on(table.lastSeenAt),
  ],
);

// The pending push-receipt ledger. Expo's send
// returns one TICKET per message; an "ok" ticket carries a RECEIPT id you fetch
// ~15min+ later (getReceipts) to learn the real delivery outcome —
// `DeviceNotRegistered` (the dead-token signal) arrives HERE, not on the ticket.
// So each ok ticket's `{ receiptId → token }` is parked here at send time; the
// receipts-sweep admin op (an external cron) drains it: fetch the receipts, prune
// the tokens Expo reports gone, delete the resolved ledger rows. `id` is the Expo
// receipt id (its natural key); `token` is the device it was sent to.
export const pushReceipts = sqliteTable(
  "push_receipts",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    token: text("token").notNull(),
  },
  (table) => [index("push_receipts_created_at_idx").on(table.createdAt)],
);

// A published mixtape's FROZEN tracklist (RFC plan→recording→mixtape). Under the
// two-table model this stays the immutable published copy: `promote` COPIES the
// winning take's `recording_cues` in here; editing a take's cues afterwards never
// touches these rows. Deploy-1 additions (all nullable, additive):
//   - `finding_id` — the eventual rename of the NOT-NULL `track_id` (the finding
//     link). The folded `db:backfill` fills it (`= track_id`) on every deploy;
//     a later slice repoints readers and drops `track_id`. Nullable so a published
//     mixtape can later carry a NON-finding live-added track as a plain row.
//   - `artists_text`/`title_text` — the snapshot for those non-finding rows.
//     Finding-backed rows keep NULL snapshots (the tracks JOIN stays the truth).
export const mixtapeTracks = sqliteTable(
  "mixtape_tracks",
  {
    artistsText: text("artists_text"),
    findingId: text("finding_id"),
    mixtapeId: text("mixtape_id").notNull(),
    position: integer("position").notNull(),
    startMs: integer("start_ms"),
    titleText: text("title_text"),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    index("mixtape_tracks_mixtape_id_idx").on(table.mixtapeId),
    uniqueIndex("mixtape_tracks_mixtape_position_idx").on(table.mixtapeId, table.position),
    uniqueIndex("mixtape_tracks_mixtape_track_idx").on(table.mixtapeId, table.trackId),
    index("mixtape_tracks_finding_id_idx").on(table.findingId),
  ],
);

// A CLIP — a lightweight 9:16 derivative cut from a recording's set video
// (the Fluncle Studio drip-feed). One set yields
// MANY clips (a backlog to drip-feed), so this is one-to-many via `recording_id`.
// NOT a spine object: a clip carries NO Log ID — the spine namespace is
// scarce/collectible, and a clip is a re-cuttable trailer, not a checkpoint.
// `in_ms`/`out_ms` are the cut window into the set; `x_offset` is the 9:16 framing
// offset baked at the ffmpeg cut (MT crop is centre-only, so the framing lives
// here, not as an MT param); `caption` is the operator/agent-authored copy (stored
// clean — the `fluncle://` coordinate is appended only at payload-build). `status`
// tracks the cut queue (`pending` → `done`) AND drives the clip-library filter.
// Distribution state lives in the sibling `mixtape_clip_social_posts` table
// (below), never `*_url` columns here.
export const mixtapeClips = sqliteTable(
  "mixtape_clips",
  {
    caption: text("caption"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    inMs: integer("in_ms").notNull(),
    outMs: integer("out_ms").notNull(),
    // The `recordings` row this clip was cut from — a clip's ONE owner since the
    // plan→recording→mixtape Deploy-2 cutover dropped the legacy `mixtape_id`
    // (every legacy mixtape-owned clip was repointed onto its mixtape's recording
    // by the folded `db:backfill` first). Still nullable at the DDL level (the
    // column predates the cutover); `createClip` always sets it. Plain text id,
    // no declared FK — matching the sibling tables (this schema declares none).
    recordingId: text("recording_id"),
    status: text("status", { enum: ["pending", "done"] })
      .notNull()
      .default("pending"),
    updatedAt: text("updated_at").notNull(),
    xOffset: integer("x_offset").notNull(),
  },
  (table) => [index("mixtape_clips_recording_id_idx").on(table.recordingId)],
);

// The clip drip-feed schedule + distribution state — the sibling to `social_posts`
// (findings) and `mixtape_social_posts` (mixtapes), one row per (clip, platform).
// Unlike those two (passive after-the-fact tracking), THIS IS THE SCHEDULE: a
// `scheduled` row carries the `scheduled_for` due time the drip cron fires at, so
// creating a clip auto-enrols it (clip-drip-feed RFC §3). `platform` is
// instagram-only today (the drip is an IG experiment); the enum leaves room to grow.
// `caption` is the built caption SNAPSHOT taken when the row was scheduled (the drip
// op rebuilds it fresh at fire time, so this is provenance, not the posted copy).
// `postiz_id` is the Postiz post id; `posted_url` the IG permalink (captured back
// later). Status: `scheduled` → `posted` (idempotent — a posted row never re-fires) or
// `failed` (retryable by the operator rescheduling it).
export const mixtapeClipSocialPosts = sqliteTable(
  "mixtape_clip_social_posts",
  {
    caption: text("caption"),
    clipId: text("clip_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["instagram"] }).notNull(),
    postedUrl: text("posted_url"),
    postizId: text("postiz_id"),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status", { enum: ["scheduled", "posted", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("mixtape_clip_social_posts_clip_platform_idx").on(table.clipId, table.platform),
    index("mixtape_clip_social_posts_status_idx").on(table.status),
  ],
);

// A lean global-flag key/value store — the reusable home for cross-cutting runtime
// switches that don't belong on any one domain row. First key: `clip_drip_paused`
// (the clip drip-feed kill switch — `'true'` pauses every future scheduled IG post
// while leaving the schedule intact; clearing it resumes the drip). `value` is opaque
// text; a boolean flag is stored as the string `'true'`/`'false'`. Add a new key here
// rather than a new single-purpose table when a flag is genuinely global.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// THE ECHO GATE'S LEDGER — every auto-note the echo gate REFUSED to store, kept.
//
// The auto-note is authored with the notes of the finding's sonic neighbours in the
// prompt, and `gateNoteEcho` (lib/server/note.ts) hard-fails a line that lifts a phrase
// from one or reuses its words wholesale. That gate is doing real work and stays exactly
// as strict as it was. What it must NOT do is work in the DARK: a pipeline that throws
// the model's output away without telling anyone is a pipeline nobody can supervise —
// the operator cannot read what was binned, cannot judge whether it was actually worse
// than nothing, and cannot see whether the THRESHOLDS are wrong, because the evidence is
// gone. So a rejection is no longer a deletion; it is a row here, and a row in the
// operator's `/admin` attention queue.
//
// ONE OPEN ROW PER FINDING (the partial unique index below). The sweep re-authors once
// per tick and the finding stays in the note queue forever while it is note-less, so an
// append-only row-per-attempt would let a single stubbornly-echoing finding write
// hundreds of rows a day. Instead a re-rejection UPDATES the open row — freshest note,
// `attempts` incremented — so the ledger is bounded by the ARCHIVE, not by the cron's
// tick rate, and the finding raises exactly one queue row. Resolved rows (accepted /
// discarded) are kept forever: they are the evidence trail behind any future retune.
//
// The thresholds IN FORCE at the moment of rejection are snapshotted onto the row
// (`min_phrase_words` / `max_overlap`). They are operator-tunable at runtime through the
// `settings` KV, so without the snapshot a retune would silently rewrite the meaning of
// every historical rejection ("why was this 0.31 note binned? the gate says 0.40").
//
// A CATALOGUE track can never appear here: the only writer is the `note_track` handler,
// which drives through `requireTrack`'s `findings ⋈ tracks` join and 404s an uncertified
// track long before a note is gated. See docs/agents/note-agent.md.
export const noteRejections = sqliteTable(
  "note_rejections",
  {
    // How many times this finding's auto-note has bounced off the gate while THIS
    // rejection stayed open (the sweep's re-author makes 2 a normal tick). A high count
    // is the signal that the region is exhausted or the gate is too tight.
    attempts: integer("attempts").notNull().default(1),
    // The FIRST time this finding's note was held — and it never moves, even though the row
    // is updated in place on a re-bounce. It is the attention queue's oldest-first anchor,
    // and that is exactly why it must not track the latest bounce: the sweep re-authors this
    // finding every tick while it stays note-less, so an anchor that moved with each bounce
    // would reset the row's age forever and it could NEVER age into the operator's working
    // set. The row that needs his eye most is the one that keeps failing; anchoring on the
    // last failure would bury it the hardest.
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    // The overlap threshold in force when this note was rejected (the `settings` value,
    // else the built-in default) — snapshotted so a later retune cannot rewrite history.
    maxOverlap: real("max_overlap").notNull(),
    // The lifted-phrase threshold in force when this note was rejected.
    minPhraseWords: integer("min_phrase_words").notNull(),
    // The neighbour it echoed hardest — the finding whose note the gate matched it against.
    neighborLogId: text("neighbor_log_id"),
    // A SNAPSHOT of the neighbour's note as it read at rejection time. Stored rather than
    // joined because the neighbour's own note can be edited or replaced later, and the
    // operator must be able to read the exact PAIR the gate compared.
    neighborNote: text("neighbor_note"),
    // THE EVIDENCE: the note the model actually wrote. The whole point of this table —
    // the operator reads this and decides for himself whether the gate was right.
    note: text("note").notNull(),
    // The measured content-word Jaccard against that neighbour (0..1).
    overlap: real("overlap").notNull(),
    // The run of words lifted from the neighbour; '' when the rejection was overlap-only.
    phrase: text("phrase").notNull().default(""),
    // The operator's ruling. NULL = still open (it raises a queue row). `accepted` = he
    // read it, judged it good, and it was written to the finding (through the same
    // fill-empty-only path the agent uses). `discarded` = the gate was right.
    resolution: text("resolution", { enum: ["accepted", "discarded"] }),
    resolvedAt: text("resolved_at"),
    // The finding whose note was rejected (no declared FK — the socialPosts.trackId /
    // cost_events.trackId precedent).
    trackId: text("track_id").notNull(),
    // The LATEST bounce — this one DOES move with `note`/`attempts` on every re-hold. It is
    // the diagnostic ("when did it last try"), never the queue's anchor (see `createdAt`).
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // ONE open rejection per finding — the bound that keeps a stubbornly-echoing finding
    // from flooding the ledger, and keeps the attention queue to one row per finding.
    // PARTIAL, so a finding may accumulate any number of RESOLVED rejections over its
    // life (the retune evidence) while only ever holding one open.
    uniqueIndex("note_rejections_open_track_idx")
      .on(table.trackId)
      .where(sql`${table.resolvedAt} is null`),
    // The queue read: "every rejection still waiting on the operator's eye", oldest first.
    index("note_rejections_open_idx").on(table.resolvedAt, table.createdAt),
  ],
);

// THE SPOKEN sibling of `note_rejections` — an observation script the echo gate refused to
// RENDER because it echoed a sonic neighbour's script, held for the operator's eye rather
// than binned (docs/agents/observation-agent.md; docs/planning/homogenisation-evidence.md,
// 2026-07-14). Same shape as the note ledger, one column renamed: the evidence is the SCRIPT
// the model wrote, and the snapshot is the NEIGHBOUR SCRIPT it echoed. The gate rejects BEFORE
// the Cartesia render, so a held rejection never cost a cent.
export const observationRejections = sqliteTable(
  "observation_rejections",
  {
    // How many times this finding's observation has bounced off the gate while THIS rejection
    // stayed open (the sweep's one re-author makes 2 a normal tick). A high count is the signal
    // that the region is exhausted or the gate is too tight.
    attempts: integer("attempts").notNull().default(1),
    // The FIRST time this finding's observation was held — the attention queue's oldest-first
    // anchor. It never moves on a re-bounce (the `created_at` invariant note_rejections carries).
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    // The overlap threshold in force when this script was rejected — snapshotted so a later
    // retune cannot rewrite history.
    maxOverlap: real("max_overlap").notNull(),
    // The lifted-phrase threshold in force when this script was rejected.
    minPhraseWords: integer("min_phrase_words").notNull(),
    // The neighbour it echoed hardest — the finding whose script the gate matched it against.
    neighborLogId: text("neighbor_log_id"),
    // A SNAPSHOT of the neighbour's script as it read at rejection time (the neighbour's own
    // script can be re-rendered later; the operator must read the exact PAIR the gate compared).
    neighborScript: text("neighbor_script"),
    // The measured content-word Jaccard against that neighbour (0..1).
    overlap: real("overlap").notNull(),
    // The run of words lifted from the neighbour; '' when the rejection was overlap-only.
    phrase: text("phrase").notNull().default(""),
    // The operator's ruling. NULL = still open (it raises a queue row). `accepted` = he read it,
    // judged it good, and it was RENDERED to the finding (the observe render path, `force`).
    // `discarded` = the gate was right.
    resolution: text("resolution", { enum: ["accepted", "discarded"] }),
    resolvedAt: text("resolved_at"),
    // THE EVIDENCE: the observation script the model actually wrote.
    script: text("script").notNull(),
    // The finding whose observation was rejected (no declared FK — the note_rejections precedent).
    trackId: text("track_id").notNull(),
    // The LATEST bounce — moves with `script`/`attempts` on every re-hold. Diagnostic, never the anchor.
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // ONE open rejection per finding — bounds the ledger and keeps the attention queue to one
    // row per finding. PARTIAL, so a finding may accumulate any number of RESOLVED rejections.
    uniqueIndex("observation_rejections_open_track_idx")
      .on(table.trackId)
      .where(sql`${table.resolvedAt} is null`),
    // The queue read: "every rejection still waiting on the operator's eye", oldest first.
    index("observation_rejections_open_idx").on(table.resolvedAt, table.createdAt),
  ],
);

// THE PROMPT HISTORY — the append-only override store behind the prompt registry
// (docs/agents/prompt-registry.md). Every prompt Fluncle feeds a model at runtime has
// a BAKED-IN DEFAULT in the repo (the registry, lib/server/prompts.ts); a row here
// OVERRIDES that default, so the operator can tune a prompt from /admin or the CLI
// with no deploy and no box rebake — which is the whole point, because a prompt is an
// iterative object and shipping a code change to reword one line is a heavy loop.
//
// WHY ITS OWN TABLE AND NOT THE `settings` KV ABOVE. The KV is the right home for a
// SCALAR whose only history is "what is it now" (a kill switch, a budget). A prompt is
// none of that: it is a versioned DOCUMENT. A bad edit silently degrades every artifact
// it touches until a human notices, so the operator must be able to see WHAT changed,
// WHEN, and put it back — and an artifact must be able to record which version drafted
// it (the `*_prompt_version` columns). A single mutable `value` cell can carry neither
// the history nor the version integer the provenance columns point at. So: one row per
// EDIT, never an update.
//
// APPEND-ONLY, and that is load-bearing. A row is never mutated and never deleted; the
// ACTIVE prompt for a slug is simply its highest `version`. That makes every operation
// a forward move with an audit trail:
//   - edit     → insert version N+1
//   - ROLL BACK to version K → insert version N+1 carrying version K's body
//   - reset    → insert version N+1 carrying the repo's baked-in default body
// A rollback is therefore just an edit whose body came from history — one operator
// action, no destructive path, and the thing you rolled back FROM stays readable.
//
// `slug` is the registry key (`note_author`, `observation_script`, …), never free text:
// an unknown slug is rejected at the API boundary, so this table cannot accumulate
// orphan prompts for sweeps that do not exist. No row for a slug ⇒ the baked default is
// live, and a sweep runs perfectly well having never read this table at all.
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    // The full prompt template. `{{variable}}` placeholders and `{{#if variable}}…
    // {{/if}}` blocks are substituted at authoring time by `renderPrompt`
    // (lib/server/prompts.ts); every other character is passed to the model verbatim.
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
    // Who made the edit. `operator` for a /admin or CLI edit (the only path today);
    // `agent` is reserved so a future self-tuning pass is legible as such in the
    // history rather than indistinguishable from a human's hand.
    createdBy: text("created_by", { enum: ["operator", "agent"] })
      .notNull()
      .default("operator"),
    id: text("id").primaryKey(),
    // The operator's WHY, shown beside the version in the history ("shortened the
    // neighbour block", "rolled back to v3"). Optional but strongly encouraged — it is
    // what makes the history readable a month later.
    note: text("note"),
    // The registry key. Validated against the registry before insert.
    slug: text("slug").notNull(),
    // Monotonic per slug, starting at 1 (version `0` is reserved, in the provenance
    // columns and nowhere else, to mean "the repo's baked-in default was live").
    version: integer("version").notNull(),
  },
  (table) => [
    // The active-prompt read is `where slug = ? order by version desc limit 1`, which
    // this index serves from its leftmost column; it also enforces the one-body-per-
    // (slug, version) invariant that makes the version integer a stable citation.
    uniqueIndex("prompt_versions_slug_version_idx").on(table.slug, table.version),
  ],
);

// Fluncle's Logbook — one first-person travelogue entry per SECTOR-DAY (the
// canonical days-since-epoch number from sectorDay()). Every day that had at least
// one finding gets a written log entry, authored nightly by the on-box
// `fluncle-logbook` sweep (a hybrid `--no-agent` cron: deterministic gap-find +
// gather, one `claude -p` authoring call, deterministic write-back via the
// agent-tier `create_logbook_entry` op). The public /logbook + /logbook/<sector>
// pages render `body` (markdown) with `[[<logId>]]` figure tokens swapped for the
// findings' poster images (docs/agents/logbook-agent.md).
//
// `sector` is the PK: one entry per sector-day, so the agent create is
// idempotent-by-construction and the fill-empty-only guarantee is a pure insert
// guard (a row already present ⇒ no-op; the operator override always wins).
// `generatedBy` records provenance — `agent` for a cron-authored entry, `operator`
// once a human has edited it (a sacred entry the agent never re-touches). The body
// is a live PUBLIC Fluncle-voice surface, so it clears the same shared voice gate
// the written note uses (banned identity words / earthly geography / the Dry Rule /
// no "we"-as-company), scanned over the prose with the figure tokens stripped.
export const logbookEntries = sqliteTable("logbook_entries", {
  // The entry body — markdown prose with `[[<logId>]]` figure tokens on their own
  // lines (the renderer swaps each for the finding's poster "photo").
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  // When the CURRENT body was authored/last (re)generated (ISO). Drives the public
  // page's lastmod + the sitemap freshness; distinct from created_at (first write).
  generatedAt: text("generated_at").notNull(),
  // Provenance: `agent` = cron-authored, `operator` = human-edited (sacred — the
  // fill-empty-only agent create never clobbers it). Plain TEXT, the enum narrows.
  generatedBy: text("generated_by", { enum: ["agent", "operator"] })
    .notNull()
    .default("agent"),
  // PROVENANCE — the `logbook_entry` prompt version this entry was authored under
  // (docs/agents/prompt-registry.md). NULL for an operator-written entry or an agent
  // fallback to the baked-in default; `0` is the registry default; a number is the live
  // `prompt_versions.version`. Pairs with `generated_by`: that says WHO wrote it, this
  // says under WHICH prompt.
  promptVersion: integer("prompt_version"),
  // The sector-day (days since the 2026-05-30 epoch — sectorDay() in
  // lib/log-id-shared.ts). The natural key: one entry per day.
  sector: integer("sector").primaryKey(),
  // The entry title (e.g. "Sector 036 — a slow drift through the low end").
  title: text("title").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// A RECORDING — a captured DJ set that is NOT (yet) a published mixtape (RFC
// recording-primitive, Design B; extended by the plan→recording→mixtape RFC's
// two-table model: a PLAN is just a recording with no video and untimed cues, a
// TAKE is a recording with video). The clip pipeline (Fluncle Studio + the cut
// engine) cuts clips from a recording's set video WITHOUT minting a scarce Log ID
// coordinate; only `promote` (→ a full published mixtape) ever mints one. So a
// recording is deliberately COORDINATE-LESS — no `logId`, no spine entry — and
// OWNS its own R2 key (unlike a mixtape, whose set video derives from its logId).
// Standalone recordings live at `recordings/<id>/set.mp4` in the existing
// `fluncle-videos` bucket (unguessable, never listed — accept-obscurity, no
// private bucket). Plain text id, no declared FK (this schema declares none).
export const recordings = sqliteTable(
  "recordings",
  {
    createdAt: text("created_at").notNull(),
    durationMs: integer("duration_ms"),
    // `randomUUID()` at insert — the repo's universal id. A recording is
    // coordinate-less, so there is no `logId` here.
    id: text("id").primaryKey(),
    // The plan's public editorial note (moves here from the draft mixtape per
    // D-plannedFor's sibling move; NULL for takes/legacy rows).
    note: text("note"),
    // The take→plan link: a take points at its plan; NULL for a plan or an
    // orphan take (e.g. the rolling set). Plain text id, no declared FK.
    parentId: text("parent_id"),
    // The scheduled date/time (ISO) of the upcoming live session this PLAN is
    // for — the plan-side home of the retired `mixtapes.planned_for`
    // (D-plannedFor). `/calendar.ics` reads upcoming sessions from here.
    plannedFor: text("planned_for"),
    // The R2 object key the recording OWNS (unlike a mixtape, which derives its
    // key from its logId). Standalone recordings: `recordings/<id>/set.mp4` in
    // the existing `fluncle-videos` bucket. NULLABLE since Deploy-1: a PLAN has
    // no video — "has video" = `r2_key IS NOT NULL`, an explicit signal.
    r2Key: text("r2_key"),
    recordedAt: text("recorded_at"),
    title: text("title").notNull(),
    // The legacy `tracklist_json` column was dropped in the plan→recording→mixtape
    // Deploy-2 cutover: `recording_cues` is a recording's ONE cue home (the folded
    // `db:backfill` migrated every legacy row there first).
    updatedAt: text("updated_at").notNull(),
    // A human display label ("v2") for a take among its plan's takes — stable and
    // explicit rather than derived from created_at order (D-version). Assigned by
    // an atomic `INSERT … SELECT coalesce(max(version),0)+1` when take-creation
    // lands (a later slice); every existing/plan row is v1.
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("recordings_parent_id_idx").on(table.parentId),
    // SQLite treats NULLs as distinct in a unique index, so orphan takes/plans
    // (parent_id NULL) coexist freely; versions are only unique WITHIN a plan.
    uniqueIndex("recordings_parent_version_idx").on(table.parentId, table.version),
  ],
);

// A recording's CUE — the recording-side unified cue row (RFC
// plan→recording→mixtape §2). One owner, always: `recording_id` is NOT NULL (the
// ownership invariant is structural — no XOR `check()` is needed beyond the NOT
// NULL itself; the checks below guard the two genuine remaining data invariants).
// Cues are MUTABLE working state (a plan's intended order, a take's played
// order); the published mixtape's tracklist stays the separate, frozen
// `mixtape_tracks` copy. `finding_id` is NULL for a played track that is not a
// Fluncle finding; `artists_text`/`title_text` snapshot the identity so a
// non-finding cue survives (and feeds the clip overlay). `start_ms` is NULL
// until the operator marks the cue's start on the set timeline in the Studio.
// Plain text ids, no declared FK (this schema declares none).
export const recordingCues = sqliteTable(
  "recording_cues",
  {
    artistsText: text("artists_text"),
    createdAt: text("created_at").notNull(),
    findingId: text("finding_id"),
    // A stable cue ref (the clip overlay keys off it) — `randomUUID()` at insert.
    id: text("id").primaryKey(),
    position: integer("position").notNull(),
    recordingId: text("recording_id").notNull(),
    startMs: integer("start_ms"),
    titleText: text("title_text"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("recording_cues_recording_position_idx").on(table.recordingId, table.position),
    index("recording_cues_recording_id_idx").on(table.recordingId),
    index("recording_cues_finding_id_idx").on(table.findingId),
    // The repo's first `check()` constraints (the RFC asked the invariants to be
    // structural): positions are 1-based like `mixtape_tracks`, and a marked
    // start time is never negative.
    check("recording_cues_position_positive", sql`"position" >= 1`),
    check("recording_cues_start_ms_non_negative", sql`"start_ms" is null or "start_ms" >= 0`),
  ],
);

// The artist entity — the canonical identity record for a music artist, keyed on the
// Spotify artist ID (the most reliable cross-platform anchor). One row per unique
// artist regardless of how many findings feature them; name variants collapse here.
// `spotifyArtistId` is nullable to admit white-label or unsigned artists whose Spotify
// profile is absent; the unique index still guards against duplicates when the id is
// present. `slug` is the real-name kebab-cased public path segment, minted once and
// never changed (collision-salted: "dimension", "dimension-2", ...). `mbid` and
// `wikidataQid` are the KG anchors (the resolver fills them; the artist pages build
// `sameAs` from them). `resolvedAt` is the single resolution stamp (null = never
// attempted; the artist-sweep queue).
export const artists = sqliteTable(
  "artists",
  {
    // ── THE VOICED BIO (the artist/label bio engine) ────────────────────────────────
    // A short, Fluncle-voiced public bio for the artist — the written sibling of a
    // finding's editorial `note`, grounded in Firecrawl facts + the tracks Fluncle has
    // actually LOGGED (never a fabricated discography). Authored by the future on-box
    // sweep via the agent-tier `describe_artist` route, which VOICE-GATES it and writes
    // it FILL-EMPTY-ONLY (an operator-written bio is never clobbered). Nullable until
    // authored; not surfaced anywhere yet (the surfacing PR reads it). See lib/server/bio.ts.
    bio: text("bio"),
    // PROVENANCE — the `describe_artist` prompt version this bio was authored under (0 =
    // the registry's baked default, N = operator override N), or NULL when no registry
    // prompt produced it (an operator-typed bio). Same contract as `note_prompt_version`.
    bioPromptVersion: integer("bio_prompt_version"),
    // The bio-authoring reliability marker, mirroring `context_status`. The future
    // bio worklist picks `pending`/NULL rows; a CONFIRMED-EMPTY fact-gather (`empty`)
    // is distinct from never-attempted so the sweep does not re-burn Firecrawl on a
    // hopeless entity. States: pending (never attempted) · resolved (a bio is stored) ·
    // empty (no usable facts) · failed (the fetch threw). Internal reliability state.
    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    // ── THE OWNED AVATAR MASTER (RFC musickit-second-authority, U3b) ─────────────────
    // The same image state machine as `albums`, so an artist serves its OWN 1200²-capped
    // avatar from our R2 instead of hotlinking `i.scdn.co`. The `backfill_cover_masters`
    // sweep (kind=artist) downloads the stored `image_url` (Spotify's largest profile
    // image — the floor, ≤640; an Apple artist-artwork template is the future higher-res
    // source decision A leaves room for) into `artists/<slug>.<ext>`, byte-verified ≤1200,
    // and stamps `image_source`. The worklist selects only artists that already carry an
    // `image_url` (a source to own), so an imageless artist stays `pending` until the
    // Spotify backfill fills it. Served via `bestArtistAvatarUrl` (media.ts) — owned master
    // preferred, raw `image_url` the fallback, the label `logo_key ?? image_url` precedent.
    imageAttemptedAt: text("image_attempted_at"),
    imageFailures: integer("image_failures").notNull().default(0),
    imageKey: text("image_key"),
    imageSource: text("image_source", { enum: ["apple", "coverart", "spotify"] }),
    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    imageUpdatedAt: text("image_updated_at"),
    // The artist's canonical avatar SOURCE — the largest Spotify profile image (an
    // `i.scdn.co` URL, the same host/precedent as `tracks.album_image_url`).
    // Filled from the Spotify `/v1/artists` lookup at entity create + by the
    // image backfill; null until fetched (the render falls back to a monogram
    // tile). The owned-master sweep downloads THIS into R2 (image_key above).
    imageUrl: text("image_url"),
    mbid: text("mbid"),
    name: text("name").notNull(),
    resolvedAt: text("resolved_at"),
    // LEGACY per-artist review stamp — superseded by `artist_socials.reviewed_at` (review
    // moved down to the link). It is no longer written or read for needs-a-look; it survives
    // only as the ONE-TIME derivation source for the per-link backfill
    // (scripts/backfill-artist-social-reviews.ts), which reads it to seed each link's stamp,
    // then never touches it again. Droppable once that backfill has run in prod.
    reviewedAt: text("reviewed_at"),
    slug: text("slug").notNull().unique(),
    spotifyArtistId: text("spotify_artist_id").unique(),
    spotifyUrl: text("spotify_url"),
    updatedAt: text("updated_at").notNull(),
    wikidataQid: text("wikidata_qid"),
  },
  (table) => [index("artists_name_idx").on(table.name)],
);

// The sonic galaxy — a stable-ID, operator-named cluster over the MuQ embedding
// space (docs/agents/cluster-engine.md). The FIRST time galaxy identity lives in the database:
// the four vibe-quadrant galaxies were a hardcoded constant (`lib/galaxies.ts`),
// derived per-track from the dead vibe axes; these are the real, sound-derived map.
// The structural precedent is `artists` (the slug-addressable public entity), with
// `artists.spotifyArtistId` as the nullable-`.unique()` precedent — SQLite treats
// NULLs as distinct in a UNIQUE index, so many unnamed galaxies coexist. `handle` is
// the permanent machine-minted admin/CLI identity (the plan-handle precedent, via
// `galaxySlug(id, attempt)`), minted once at birth, never renamed, never public;
// `name`/`slug` are the operator-authored public identity, NULL until named (an
// unnamed galaxy is admin-only). `centroidJson` is the 1024-d nightly assignment
// anchor. `retiredAt` is set when a galaxy empties (row kept, ID never recycled);
// `splitRequestedAt` is the operator's split trigger the nightly tick consumes.
// Member counts are DERIVED (`COUNT(*) GROUP BY galaxy_id`), never stored. See
// docs/agents/cluster-engine.md.
export const galaxies = sqliteTable("galaxies", {
  centroidJson: text("centroid_json").notNull(),
  createdAt: text("created_at").notNull(),
  handle: text("handle").notNull().unique(),
  id: text("id").primaryKey(),
  name: text("name"),
  retiredAt: text("retired_at"),
  slug: text("slug").unique(),
  splitRequestedAt: text("split_requested_at"),
  updatedAt: text("updated_at").notNull(),
});

// The many-to-many join between tracks (findings) and their artists. `position` is
// 1-based and records the original Spotify artist order (first = lead). Composite PK
// (track_id, artist_id) enforces uniqueness.
//
// ── `role` — the credit KIND (RFC label-lineage-remixer, U2) ──────────────────────
// NULL = a performer (the default, and the ONLY kind v1 had — a lead/featured artist).
// `'remixer'` is the first non-null value, DERIVED — never guessed — where the title's
// "(X Remix)" descriptor names a remixer who EXACTLY folds to one of the track's linked
// artists (`deriveRemixerNames`, track-match.ts; stamped by `stampRemixerRoles`,
// artists.ts, at the publish / crawler / anchor write paths + the deploy backfill). An
// unmatched remixer name (an uncertified remixer with no `artists` row) stays absent —
// there is no row to stamp. The credit is markup-only for now: it becomes a schema.org
// `contributor` Role on the MusicRecording (log-schema.ts); the visible page is unchanged.
export const trackArtists = sqliteTable(
  "track_artists",
  {
    artistId: text("artist_id").notNull(),
    position: integer("position").notNull(),
    role: text("role", { enum: ["remixer"] }),
    trackId: text("track_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trackId, table.artistId] }),
    index("track_artists_track_id_idx").on(table.trackId),
    index("track_artists_artist_id_idx").on(table.artistId),
  ],
);

// ── The similar-artists engine's derived artifacts (artist-relationship doc, D6) ─────────────
//
// Two precomputed tables that lift the `/artist/<slug>` "similar artists" rail off the
// page-load whole-corpus vector read. They are to the artist graph what the `catalogue_*`
// ranking columns are to The Ear (docs/the-ear.md): a nightly-style precompute, self-healing
// off a PER-ARTIST fingerprint, so the request path does no vector math. The `rank_artists` sweep
// (lib/server/artist-dossier.ts) writes them; `getArtistNeighbours` reads `artist_similar`.

// One artist's position in MuQ embedding space — the MEAN over EVERY embedded track that
// credits them, findings AND catalogue alike (the rail is catalogue-wide by design; the only
// filter is `embedding_blob IS NOT NULL`). The artist-level mean is the accepted shape here:
// The Ear's max-similarity-never-a-centroid doctrine is about a per-USER taste that is
// multi-modal, whereas an artist's own discography IS the thing being summarised, so its
// centroid is a faithful identity point. `vector_count` is how many track vectors folded into
// the mean (0 means the artist lost all embeddings — its row + edges are dropped). `rank_corpus`
// is the PER-ARTIST staleness fingerprint the sweep stamped (`"<version>:<this artist's embedded-track
// count>"`): a row whose fingerprint disagrees with the artist's live count is stale and recomputes
// on a later tick — so a new finding re-stales only the artists it credits, never the whole archive.
// `centroid_blob` is a native `F32_BLOB(1024)` so the edge re-rank ranks it IN SQL
// (`vector_distance_cos`), never in the isolate.
export const artistCentroids = sqliteTable("artist_centroids", {
  artistId: text("artist_id").primaryKey(),
  centroidBlob: float32Vector("centroid_blob").notNull(),
  computedAt: text("computed_at").notNull(),
  rankCorpus: text("rank_corpus").notNull(),
  vectorCount: integer("vector_count").notNull(),
});

// The precomputed top-K sonically-nearest neighbours for each artist — the edges the rail reads.
// K is 8 (the rail shows 4; the headroom is for the MCP `get_similar_artists` tool). `similarity`
// is cosine similarity to the target's centroid (1 − `vector_distance_cos`), `rank` is its 0-based
// position (0 = nearest). The PK is (artist_id, rank): the read is an ordered PK-prefix walk of one
// artist's edges (`order by rank limit N`), a btree range scan, never a table scan of a growing
// table — no `desc()` anywhere (SQLite reverse-scans a plain ASC index for a descending read).
// `rank_corpus` is the edge-freshness fingerprint (the same value the centroids carry), so the
// sweep can tell an artist's edges from an older corpus apart from fresh ones and re-rank the drift.
export const artistSimilar = sqliteTable(
  "artist_similar",
  {
    artistId: text("artist_id").notNull(),
    computedAt: text("computed_at").notNull(),
    neighbourArtistId: text("neighbour_artist_id").notNull(),
    rank: integer("rank").notNull(),
    rankCorpus: text("rank_corpus").notNull(),
    similarity: real("similarity").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artistId, table.rank] }),
    index("artist_similar_neighbour_idx").on(table.neighbourArtistId),
  ],
);

// The artist social identity graph — one row per (artist, platform). Mirrors
// `mixtape_social_posts` structurally. `platform` covers the social surfaces only
// (spotify|youtube|mixcloud|soundcloud|instagram|tiktok|bandcamp|twitter|facebook|
// homepage); the KG anchors mbid/wikidata live as `artists` columns, NOT here.
// `source` records who found the link. `status` is the trust state: MB-sourced or
// operator-added links are `auto` (trusted); Firecrawl-found links are `candidate`
// until an operator confirms them — `candidate` rows are excluded from the public
// artist page and `sameAs` JSON-LD until promoted to `confirmed`. This is the identity
// graph that feeds the public artist page + `sameAs`; there is no follow/champion state.
export const artistSocials = sqliteTable(
  "artist_socials",
  {
    artistId: text("artist_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    platform: text("platform", {
      enum: [
        "spotify",
        "youtube",
        "mixcloud",
        "soundcloud",
        "instagram",
        "tiktok",
        "bandcamp",
        "beatport",
        "twitter",
        "facebook",
        "twitch",
        "homepage",
      ],
    }).notNull(),
    // When the operator last acknowledged THIS link — the review stamp, moved down from
    // the artist (docs/artist-relationship.md). Review lands on the LINK, not the artist:
    // a link "needs a look" when `reviewed_at IS NULL`. A resolver INSERT (a new link) or a
    // URL CHANGE nulls this (born/re-armed unreviewed); an untouched re-resolve keeps it; an
    // operator add/edit is born reviewed (`reviewed_at = now`, they just wrote it). "Looks
    // good" bulk-stamps every one of an artist's links; the fresh-links section stamps one.
    reviewedAt: text("reviewed_at"),
    source: text("source", { enum: ["musicbrainz", "firecrawl", "operator"] }).notNull(),
    status: text("status", { enum: ["auto", "candidate", "confirmed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    uniqueIndex("artist_socials_artist_platform_idx").on(table.artistId, table.platform),
    // The fresh-links queue + the board's fresh-links section both scan for the unreviewed
    // links (`reviewed_at IS NULL`); a partial index keeps that scan bounded as socials grow.
    index("artist_socials_unreviewed_idx").on(table.reviewedAt),
    index("artist_socials_artist_id_idx").on(table.artistId),
    index("artist_socials_platform_idx").on(table.platform),
  ],
);

// The record LABEL — a first-class entity, and the operator's CRAWL-SEED control.
//
// `tracks.label` stays what it has always been: the raw captured string Deezer
// handed back on the add. This table is its normalized twin, related by `slug`
// (`slugify(tracks.label) = labels.slug`), so `Pilot.` and `Pilot` fold into one
// label without a destructive rewrite of the findings. Every label appearing on a
// finding gets a row automatically (the publish path upserts it; the deploy-time
// reconcile is the self-healing backstop).
//
// ── `seed_state` IS CRAWL SCOPE, NEVER STORAGE ──────────────────────────────────
// This column answers exactly one question: MAY THE FUTURE CATALOGUE CRAWLER SEED
// FROM THIS LABEL? Nothing else. It is the operator's explicit ruling, and it must
// stay that way in every reader:
//   - `enabled`    — the next crawl may seed from this label.
//   - `disabled`   — the next crawl may NOT. It removes the label from the NEXT
//                    crawl's seed set and touches NOTHING already stored: no
//                    deletion, no hiding, no retroactive effect on tracks, on
//                    findings, or on anything a previous crawl already brought in.
//                    A disabled label's findings keep rendering exactly as before.
//   - `undecided`  — the operator has not ruled yet. A brand-new label enters HERE
//                    (the DDL default): never silently crawled, never silently
//                    dropped. It surfaces as an `/admin` attention row until ruled.
// "What we crawl FROM" and "what we KEEP" are separate concepts. Never join this
// column to a read that decides what is shown, kept, or deleted.
//
// `ruled_at` is the OPERATOR's stamp — set only by the operator-tier `update_label`
// write. NULL means no human has ruled this label, which is what lets the one-time
// D7 bootstrap (scripts/backfill-labels.ts) seed a state without ever clobbering an
// operator's decision. `slug` is the identity + the join key. The catalogue crawler
// reads the enabled set via `list_labels_admin?seedState=enabled`. See docs/label-entity.md.
// ── THE LABEL'S OWN IMAGE (its real logo, not a borrowed album cover) ───────────
// A label surface (the /labels cards, the /label/<slug> page, search, the hover
// card) used to show the freshest finding's album art as the label's picture — an
// arbitrary sleeve for every label whose cover doesn't happen to carry the logo.
// These columns give a label its OWN image, resolved from Discogs (labels are
// first-class there and `GET /labels/{id}` returns a real logo), with a Wikidata
// P154 fallback and the freshest-cover as the floor. The identity is walked once
// (MusicBrainz label search → its curated Discogs/Wikidata url-rels), the image is
// downloaded ONCE and stored in our own R2 (never hotlinked — Discogs' ToS forbids
// it and image requests need the authed token), and the resolve state keeps a
// failure from being retried forever. See docs/label-entity.md + label-images.ts.
//   - `mb_label_id` / `discogs_label_id` — the resolved external identity. The
//     crawler already resolves the MB id at walk time and now persists it here;
//     the resolve sweep backfills the rest (and the labels the crawler never walks).
//   - `image_key` — the R2 object key of the stored logo (served from
//     found.fluncle.com via `labelLogoUrl`). NULL = no own image, fall to the cover.
//   - `image_state` — the resolve lifecycle: `pending` (needs a pass; the DDL
//     default, so every existing + future label enters the worklist), `resolved`
//     (has a logo), `none` (checked, no image anywhere — terminal, floors to cover).
//   - `image_attempted_at` / `image_failures` — the reliability pair (the shipped
//     backfill convention): a transient failure backs off and is retried; a
//     persistent one gives up (→ `none`), so the sweep never storms a vendor.
export const labels = sqliteTable(
  "labels",
  {
    // ── THE VOICED BIO (the artist/label bio engine) ────────────────────────────────
    // A short, Fluncle-voiced public bio for the label — the written sibling of a finding's
    // editorial `note`, grounded in Firecrawl facts + the tracks Fluncle has actually LOGGED
    // on this label (never a fabricated roster). Authored by the future on-box sweep via the
    // agent-tier `describe_label` route, which VOICE-GATES it and writes it FILL-EMPTY-ONLY
    // (an operator-written bio is never clobbered). Nullable until authored; not surfaced
    // anywhere yet (the surfacing PR reads it). See lib/server/bio.ts.
    bio: text("bio"),
    // PROVENANCE — the `describe_label` prompt version this bio was authored under (0 = the
    // registry's baked default, N = operator override N), or NULL when no registry prompt
    // produced it (an operator-typed bio). Same contract as `note_prompt_version`.
    bioPromptVersion: integer("bio_prompt_version"),
    // The bio-authoring reliability marker, mirroring `context_status`: pending (never
    // attempted) · resolved (a bio is stored) · empty (no usable facts) · failed (the fetch
    // threw). Internal reliability state; the future bio worklist picks `pending`/NULL rows.
    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),
    createdAt: text("created_at").notNull(),
    // The Discogs label id (from the MB label's curated Discogs url-rel) — the source
    // of the logo image. NULL until the resolve sweep walks it (or MB carried no link).
    discogsLabelId: integer("discogs_label_id"),
    // ── LABEL LINEAGE (RFC label-lineage-remixer, U1) ───────────────────────────────
    // The label's founding place — MusicBrainz's `area.name` (e.g. "London", "United
    // Kingdom"). Emitted as the Organization's `location` Place on `/label/<slug>` and
    // (with `founding_date`) as the visible "Founded 1996 · London" reference line. NULL
    // until the lineage sweep walks it, or when MB carries no area. See label-lineage.ts.
    foundedLocation: text("founded_location"),
    // The label's founding date — MusicBrainz's `life-span.begin`, stored VERBATIM (a bare
    // year "1996" or a full date "1996-04-29"; never re-formatted). Emitted as the
    // Organization's `foundingDate` (schema.org accepts a year or a full date). NULL until
    // walked, or when MB carries no begin date.
    foundingDate: text("founding_date"),
    id: text("id").primaryKey(),
    // The last time the image resolve sweep attempted this label (reliability/backoff).
    imageAttemptedAt: text("image_attempted_at"),
    // Consecutive resolve failures — drives the backoff and the give-up cap (→ `none`).
    imageFailures: integer("image_failures").notNull().default(0),
    // The R2 object key of the stored logo (e.g. `labels/<slug>.jpg`), served from
    // found.fluncle.com. NULL = no own image; the surface falls back to the cover.
    imageKey: text("image_key"),
    // The image resolve lifecycle (see the header). `pending` is the DDL default so
    // every label — existing and future — enters the worklist automatically.
    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    // ── THE FRESHNESS TAP (D8) ───────────────────────────────────────────────────────
    // A second vendor (Spotify) taps day-one freshness for ENABLED seed labels only: a bounded
    // per-label probe that mints METADATA-ONLY catalogue rows with day-one release dates, closing
    // the ~2-week MusicBrainz-editorial-lag cliff on /fresh. MusicBrainz still WALKS the graph
    // (crawl.ts); the tap only TAPS freshness — it never expands the graph (no new labels, no artist
    // hops) and never certifies. There is NO id-resolution step: the label NAME is the Spotify
    // `label:` query, corroborated by the album's copyrights. See label-releases.ts.
    //   - `label_releases_checked_at`   — when the probe last SUCCESSFULLY tapped this label's fresh
    //                                     releases. Drives the oldest-first rotation + the re-probe
    //                                     cadence. NULL until first probed.
    //   - `label_releases_attempted_at` / `label_releases_failures` — the reliability pair (the
    //                                     label-images convention): the last attempt that hit a
    //                                     TRANSIENT Spotify error + the consecutive-error streak,
    //                                     driving the failure-scaled backoff.
    labelReleasesAttemptedAt: text("label_releases_attempted_at"),
    labelReleasesCheckedAt: text("label_releases_checked_at"),
    labelReleasesFailures: integer("label_releases_failures").notNull().default(0),
    // ── LABEL LINEAGE reliability (the label-images convention, cloned) ──────────────────────
    // The lineage sweep (label-lineage.ts) walks each label's MusicBrainz life-span + area +
    // its label-label relationships once, up its own terminal state machine — the label-images
    // triple, applied to lineage instead of the logo, so a resolved/none label is never re-walked
    // and a persistent failure gives up.
    //   - `lineage_attempted_at` — the last attempt (drives the cooldown backoff).
    //   - `lineage_failures` — consecutive failures (drives the give-up cap → `none`).
    //   - `lineage_state` — `pending` (the DDL default, so every existing + future label enters
    //     the worklist), `resolved` (walked; whatever MB carried is stored), `none` (no MB
    //     identity to walk — terminal).
    lineageAttemptedAt: text("lineage_attempted_at"),
    lineageFailures: integer("lineage_failures").notNull().default(0),
    lineageState: text("lineage_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    // ── THE DISCOVERED-LABEL FOLD KEY (catalogue-graph, inline label linking) ────────────────
    // The MusicBrainz label MBID — the STABLE identity a DISCOVERED label folds on, so a crawled
    // release's label edge collapses two spellings that slugify apart ("Med School" ⇄ "Medschool")
    // onto one row, rather than minting a duplicate. The crawler resolves it at walk time (the seed
    // path via `expandSeedLabel` → `setLabelMbLabelId`; the discovered path via `ensureLabel(name,
    // mbLabelId)`), and the image sweep walks it for the label's curated Discogs + Wikidata url-rels.
    // Nullable and NON-KEYING for existing rows: a publish-minted / pre-crawl label folds on `slug`
    // and carries NULL here until the one-off `backfill-label-mbid.ts` populates it, and a discovered
    // label with no MBID still folds by the slug/alias path. UNIQUE index below — SQLite treats NULLs
    // as distinct, so the many NULL rows never collide. See docs/label-entity.md.
    mbLabelId: text("mb_label_id"),
    // The display name — the first raw `tracks.label` spelling seen for this slug.
    name: text("name").notNull(),
    // ── THE PARENT EDGE (RFC label-lineage-remixer, U1) ─────────────────────────────
    // The `labels.id` this label is a SUBLABEL / imprint of — MusicBrainz's `label ownership`
    // / `imprint` label-rel walked with `direction = 'backward'` (verified against real MB data:
    // Med School → Hospital Records). A self-reference, nullable; the smallest honest model, since
    // an imprint has one parent in practice and the SUBLABELS are the reverse read (`where
    // parent_label_id = ?`). Set fill-empty-only by the lineage sweep, and ONLY when the parent MB
    // label already exists in `labels` by MBID — this path NEVER mints a label (an unmatched parent
    // is counted in the sweep summary, never created). Emitted as the Organization's
    // `parentOrganization` / `subOrganization` `@id` edges. See label-lineage.ts.
    parentLabelId: text("parent_label_id"),
    ruledAt: text("ruled_at"),
    seedState: text("seed_state", { enum: ["enabled", "disabled", "undecided"] })
      .notNull()
      .default("undecided"),
    slug: text("slug").notNull().unique(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // The discovered-label fold: `where mb_label_id = ?` resolves an existing label before the
    // alias/slug path, so one MusicBrainz label is one row across every spelling it walks in under.
    uniqueIndex("labels_mb_label_id_idx").on(table.mbLabelId),
    // The SUBLABELS reverse read (`where parent_label_id = ?`) — the `/label/<slug>` page's
    // `subOrganization` edges. An indexed seek, not a scan of the growing labels table.
    index("labels_parent_label_id_idx").on(table.parentLabelId),
    // The lineage sweep's worklist: `where lineage_state = 'pending'`, slug-cursored. A PARTIAL
    // index over exactly the un-walked slice, so its cost SHRINKS as the backlog drains rather
    // than scanning the whole (crawler-swollen) labels table each tick (the recording-mbids
    // `tracks_mb_recording_id_queue_idx` discipline).
    index("labels_lineage_queue_idx")
      .on(table.slug)
      .where(sql`${table.lineageState} = 'pending'`),
    // The freshness-tap worklist (D8): the probe reads ENABLED seed labels oldest-probe first
    // (`order by label_releases_checked_at asc`). A PARTIAL index over exactly that allowlisted
    // slice, so the probe never scans the crawler-swollen labels table — the seed set is tens of
    // rows, the table is thousands. Plain ASC (SQLite reverse-scans it); a `desc()` index poisons
    // the snapshot (the drizzle-kit desc-index trap).
    index("labels_label_releases_queue_idx")
      .on(table.labelReleasesCheckedAt)
      .where(sql`${table.seedState} = 'enabled'`),
  ],
);

// LABEL ALIASES — two spellings, one label, ISRC-anchored trust (RFC musickit-second-authority,
// U2a). The `artist_socials` precedent: a per-label side table of alternative spellings, each
// carrying its source + a candidate/confirmed status, so a second metadata authority (Apple's
// album `recordLabel`, corroborated by MusicBrainz over a shared ISRC) can propose that
// "Med School Recordings" is the same label as "Medschool" WITHOUT ever rewriting the immutable
// `tracks.label` string or auto-changing `labels.name`. A JSON column was rejected on the label
// entity's own no-denormalization principle (docs/label-entity.md).
//
// ── WHAT EACH COLUMN IS ─────────────────────────────────────────────────────────
//   - `label_id`   — the CANONICAL label this alias belongs to. The alias is another spelling
//                    OF this label, never a label of its own.
//   - `alias`      — the raw alternative spelling (Apple's `recordLabel`, an operator's typing).
//   - `alias_slug` — `slugify(alias)`, INDEXED: the join key the resolution wiring reads by, so
//                    a CONFIRMED alias's slug resolves to `label_id` BEFORE `ensureLabel` /
//                    `reconcileLabels` would otherwise re-mint it as a new label. This is the
//                    whole correctness point — the immutable `tracks.label` re-mints merged-away
//                    slugs on every deploy backfill unless the mint path consults this first.
//   - `source`     — where the spelling came from. `apple` is the U2a writer; `operator` is a
//                    hand-added alias; `musicbrainz`/`discogs`/`spotify` are reserved for future
//                    corroboration sources.
//   - `kind`       — `name` (a corroborated alternate spelling — Apple AND MusicBrainz agree on
//                    the same label over the ISRC) or `hint` (a weaker lead — Apple names a label
//                    the archive does not recognise as this one, or a distributor string). Only
//                    the operator's CONFIRM promotes either to the public graph.
//   - `status`     — `candidate` (awaiting the operator) or `confirmed` (ruled the same label).
//                    ONLY `confirmed` feeds resolution + the public `alternateName` JSON-LD
//                    (decision C); `candidate`/`hint` stay admin-only. Reject deletes the row.
//
// The derivation is IDEMPOTENT and never clobbers a ruling: the unique index is
// `(label_id, alias_slug, source)` with `on conflict do nothing`, so a re-run over a
// `confirmed` row is a no-op. See docs/label-entity.md + scripts/backfill-label-aliases.ts.
export const labelAliases = sqliteTable(
  "label_aliases",
  {
    alias: text("alias").notNull(),
    aliasSlug: text("alias_slug").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["name", "hint"] }).notNull(),
    labelId: text("label_id").notNull(),
    source: text("source", {
      enum: ["operator", "apple", "musicbrainz", "discogs", "spotify"],
    }).notNull(),
    status: text("status", { enum: ["candidate", "confirmed"] }).notNull(),
  },
  (table) => [
    // One spelling per (label, source): the derivation upserts `on conflict do nothing`, so a
    // second pass never duplicates a candidate and never reverts a confirmed row.
    uniqueIndex("label_aliases_label_slug_source_idx").on(
      table.labelId,
      table.aliasSlug,
      table.source,
    ),
    // The resolution read (`ensureLabel` / `reconcileLabels`): `where alias_slug = ? and
    // status = 'confirmed'`. Bounded as aliases grow.
    index("label_aliases_alias_slug_idx").on(table.aliasSlug),
    // The `/admin/labels` review section reads the open candidates (`where status = 'candidate'`).
    index("label_aliases_status_idx").on(table.status),
  ],
);

// ARTIST ALIASES — DnB's many-names problem, solved the label_aliases way (the MusicBrainz
// identity layer). The exact structural twin of `label_aliases` above: a per-artist side table
// of alternative spellings, each carrying its source + a status, so the many names a DnB act
// records under (the alias, the real name, the sort name, a locale variant) reconcile to ONE
// artist entity WITHOUT ever rewriting `artists.name`. MusicBrainz curates these directly
// (`inc=aliases` on the artist lookup), so the resolve pipeline harvests them on the same walk it
// already makes for socials + KG anchors (artist-resolution.ts).
//
// ── WHAT EACH COLUMN IS (the label_aliases shape) ───────────────────────────────
//   - `artist_id`  — the CANONICAL artist this alias belongs to (`artists.id`). The alias is
//                    another spelling OF this artist, never an artist of its own.
//   - `alias`      — the raw alternative spelling (a MusicBrainz alias, an operator's typing).
//   - `alias_slug` — `slugify(alias)`, INDEXED: the fold key. A confirmed/auto alias's slug is
//                    the artist under another name, kept off the canonical `artists.name`.
//   - `source`     — where the spelling came from. `musicbrainz` is the harvester; `operator` is
//                    a hand-added alias; the rest are reserved for future corroboration sources.
//   - `kind`       — `name` (a real display name — a MusicBrainz "Artist name"/"Legal name"
//                    alias, or an operator's) or `hint` (a MusicBrainz "Search hint" — a weaker
//                    lead kept for the record but NEVER rendered publicly).
//   - `status`     — the TRUST state, mirroring `artist_socials` (not `label_aliases`' weaker
//                    candidate/confirmed): `auto` (a MusicBrainz-curated alias — authoritative
//                    and DIRECT, so trusted/public exactly as MB socials are born `auto`) or
//                    `confirmed` (an operator-added/ruled alias). ONLY `auto`/`confirmed` of
//                    `kind='name'` feed the public `alternateName` JSON-LD. There is deliberately
//                    NO `candidate` tier: a MusicBrainz alias is a direct statement of identity,
//                    not the fuzzy cross-source inference `label_aliases`' Apple×ISRC candidate
//                    guards — the same reason MB socials skip `candidate` and are born `auto`.
//
// IDEMPOTENT and never clobbers a ruling: the unique index is `(artist_id, alias_slug, source)`
// with `on conflict do nothing`, so a re-resolve over an existing alias is a no-op. See
// docs/artist-relationship.md.
export const artistAliases = sqliteTable(
  "artist_aliases",
  {
    alias: text("alias").notNull(),
    aliasSlug: text("alias_slug").notNull(),
    artistId: text("artist_id").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["name", "hint"] }).notNull(),
    source: text("source", {
      enum: ["operator", "musicbrainz", "discogs", "spotify"],
    }).notNull(),
    status: text("status", { enum: ["auto", "confirmed"] }).notNull(),
  },
  (table) => [
    // One spelling per (artist, source): the harvest upserts `on conflict do nothing`, so a
    // re-resolve never duplicates an alias and never reverts an operator ruling.
    uniqueIndex("artist_aliases_artist_slug_source_idx").on(
      table.artistId,
      table.aliasSlug,
      table.source,
    ),
    // The public read (`where artist_id = ? and status in ('auto','confirmed') and kind='name'`)
    // and the fold read (`where alias_slug = ?`). Bounded as aliases grow.
    index("artist_aliases_artist_id_idx").on(table.artistId),
    index("artist_aliases_alias_slug_idx").on(table.aliasSlug),
  ],
);

// The ALBUM — the fourth node of the graph (log ↔ artist ↔ label ↔ album), and the
// structural twin of `labels` above: `tracks.album` stays the raw captured string
// forever, this table is its normalized twin related by `slug`
// (`slugify(tracks.album) = albums.slug`), and `tracks.album_id` is the indexed pointer
// the public page reads by. Everything true of `labels` is true here, minus the seed
// control: an album is not a crawl seed, so it carries NO `seed_state` and NO `ruled_at`.
// There is nothing for an operator to rule on — which is why there is no `/admin/albums`.
//
// A row is minted two ways, and folded on two identities. The publish path mints one off a
// CERTIFIED finding, keyed on the `slug`. The catalogue crawler mints one INLINE for the
// release it walks (`ensureAlbum` in crawl.ts), keyed on the `release_group_mbid` — the stable
// fold over a record's pressings — falling back to the slug when MusicBrainz has no release
// group. So an album entity now exists for a catalogue-only record too (the crawler is to
// albums what it already is to `labels`: a mint path), and `tracks.album_id` is stamped off the
// bat rather than at a deploy backfill. The `/albums` EDITORIAL index stays bounded by the
// archive (it is findings-joined — `listAlbumsWithFindingCounts`); the crawl-minted rows are the
// "other songs on this album" tier and reach a public `/album/<slug>` only through the
// renderable-track thin-content gate.
//
// The known limit, inherited from the slug identity: two different albums that share a
// name fold into one row (`labels`' `Pilot.`/`Pilot` fold, run the other way). The
// disambiguation answer is the alias map docs/label-entity.md already records as the
// eventual fix for both entities; it is not a normalizer's job. See docs/album-entity.md.
export const albums = sqliteTable(
  "albums",
  {
    // ── Apple Music ALBUM FACTS (RFC musickit-second-authority, U1) ────────────────────────
    // Written ONCE per album by the Apple sweep, off the single-ISRC oracle's canonical-album
    // picker (`appleCatalogLookupByIsrc` → `canonicalAlbum`). recordLabel is an ALBUM attribute,
    // so storing it at album grain fixes "recordLabel differs per pressing" structurally: U2
    // reads `record_label_raw` as its second label authority, U3 reads the artwork template as a
    // ≥1920 cover source. NULL-safe: an honest miss (no album included, or a compilation-only
    // pressing set) writes nothing, and `apple_album_id IS NULL` is the "not yet fetched" gate
    // that makes the fetch once-per-album. `artwork_url_template` keeps Apple's `{w}x{h}` tokens
    // intact (substituted by `appleArtworkUrl`); the palette (`artwork_bg_color`/`text_color1..4`)
    // is what Apple derives from the cover. `upc` is the album's barcode.
    appleAlbumId: text("apple_album_id"),
    artworkBgColor: text("artwork_bg_color"),
    artworkHeight: integer("artwork_height"),
    artworkTextColor1: text("artwork_text_color1"),
    artworkTextColor2: text("artwork_text_color2"),
    artworkTextColor3: text("artwork_text_color3"),
    artworkTextColor4: text("artwork_text_color4"),
    artworkUrlTemplate: text("artwork_url_template"),
    artworkWidth: integer("artwork_width"),
    // ── THE VOICED BIO (the artist/label/album bio engine) ──────────────────────────
    // A short, Fluncle-voiced public bio for the album — the written sibling of a finding's
    // editorial `note`, grounded in Firecrawl facts + the tracks Fluncle has actually LOGGED
    // off this record (never a fabricated tracklist). Authored by the on-box sweep via the
    // agent-tier `describe_album` route, which VOICE-GATES it and writes it FILL-EMPTY-ONLY
    // (an operator-written bio is never clobbered). Nullable until authored. See lib/server/bio.ts.
    bio: text("bio"),
    // PROVENANCE — the `describe_album` prompt version this bio was authored under (0 = the
    // registry's baked default, N = operator override N), or NULL when no registry prompt
    // produced it (an operator-typed bio). Same contract as `note_prompt_version`.
    bioPromptVersion: integer("bio_prompt_version"),
    // The bio-authoring reliability marker, mirroring `context_status`: pending (never
    // attempted) · resolved (a bio is stored) · empty (no usable facts) · failed (the fetch
    // threw). Internal reliability state; the future bio worklist picks `pending`/NULL rows.
    bioStatus: text("bio_status", { enum: ["pending", "resolved", "empty", "failed"] }),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    // ── THE OWNED COVER MASTER (RFC musickit-second-authority, U3b) ─────────────────────────
    // The `labels` image state machine, cloned onto the album so every album serves its OWN
    // 1200²-capped cover derivative from our R2 (found.fluncle.com) instead of hotlinking a
    // third party. The `backfill_cover_masters` sweep (cover-masters.ts) fetches a ≤1200
    // rendition from the BEST source — Apple's stored `artwork_url_template` substituted to
    // ≤1200 (native downscale, no local resize), then Cover Art Archive, then Spotify's 640 as
    // the floor — and stores it at `albums/<slug>.<ext>`, downscale-guaranteed by the requested
    // size and byte-verified ≤1200 before the R2 put. The 3000² original is NEVER stored or
    // served (the REF-05 line); the video render still fetches Apple's full-res at render time,
    // never persisted. Served via Cloudflare Images `/cdn-cgi/image/…` (decision B) — see
    // media.ts `ownedCoverUrl` + `bestAlbumCoverUrl`, and docs/album-artwork.md.
    //   - `image_key`        — the R2 object key of the stored master (e.g. `albums/<slug>.jpg`).
    //                          NULL = no owned master; the DTO falls through to the Spotify chain.
    //   - `image_source`     — which rung won: `apple` | `coverart` | `spotify`. NULL until resolved.
    //   - `image_state`      — `pending` (DDL default; every album enters the worklist), `resolved`
    //                          (has a master), `none` (no source anywhere — terminal, floors to the
    //                          stored Spotify cover).
    //   - `image_updated_at` — the `?v` bust VINTAGE: a replaced master bumps it, re-keying the
    //                          Cloudflare Images rendition cache (the video-variants `?v` lesson —
    //                          a transform cache survives a zone purge).
    //   - `image_attempted_at` / `image_failures` — the shipped reliability pair (backoff + give-up).
    imageAttemptedAt: text("image_attempted_at"),
    imageFailures: integer("image_failures").notNull().default(0),
    imageKey: text("image_key"),
    imageSource: text("image_source", { enum: ["apple", "coverart", "spotify"] }),
    imageState: text("image_state", { enum: ["pending", "resolved", "none"] })
      .notNull()
      .default("pending"),
    imageUpdatedAt: text("image_updated_at"),
    // The display name — the first raw `tracks.album` spelling seen for this slug.
    name: text("name").notNull(),
    recordLabelRaw: text("record_label_raw"),
    // ── THE CATALOGUE FOLD KEY (catalogue-graph, inline album linking) ──────────────────────
    // The MusicBrainz release-group MBID — the STABLE identity the catalogue crawler folds an
    // album on, so a crawled track's album edge is written inline at crawl time rather than
    // deferred to a deploy backfill. A release group is MusicBrainz's "album" abstraction over
    // its pressings, and every release belongs to exactly one, so it is the right grain to
    // dedupe on. Nullable and NON-KEYING for existing rows: a finding-minted album folds on
    // `slug` and carries NULL here until the one-off `backfill-album-graph.ts` populates it, and
    // a crawled track whose release has no release group still links by the slug path. `upc`
    // stays a stored FACT (the album barcode), never the fold key. UNIQUE index below — SQLite
    // treats NULLs as distinct, so the many NULL rows never collide. See docs/album-entity.md.
    releaseGroupMbid: text("release_group_mbid"),
    slug: text("slug").notNull().unique(),
    upc: text("upc"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // The catalogue crawler's connect-or-create fold: `where release_group_mbid = ?` resolves an
    // existing album before the slug path, so one release group is one row across every pressing.
    uniqueIndex("albums_release_group_mbid_idx").on(table.releaseGroupMbid),
  ],
);

// THE CRAWL FRONTIER — the catalogue crawler's durable, resumable work queue.
//
// The crawler walks the MusicBrainz release graph outward from the labels the operator
// ENABLED (`labels.seed_state`), writing catalogue rows into `tracks` and never a
// `findings` row. It runs as a bounded, polite, `--no-agent` sweep: one tick expands a
// handful of nodes at ~1 req/s and stops. So the walk's whole state has to live HERE,
// not in a process — a tick that dies mid-label must be resumed by the next one, not
// restarted. See docs/catalogue-crawler.md.
//
// ── ONE ROW = ONE NODE OF THE GRAPH, AND ONE UNIT OF WORK ──────────────────────
//   - `label`   — hop 0. Two flavours, and the pair is what makes label resolution
//                 itself resumable: the SEED (`source: 'fluncle'`, `external_id` = the
//                 `labels.slug` the operator enabled) expands into the MB entity
//                 (`source: 'musicbrainz'`, `external_id` = the MB label MBID), which
//                 expands into its releases.
//   - `release` — expands into the tracks it carries (the write) + the artists on them.
//   - `artist`  — expands into that artist's OTHER releases.
//
// ── `hop` IS THE BOUNDARY GATE ─────────────────────────────────────────────────
// The operator drew the lane when he ruled on the labels; the crawler simply does not
// leave the neighbourhood. It is graph DISTANCE from an enabled label, never a genre
// guess (no MusicBrainz/Discogs tag inference — that ruling is ratified):
//   hop 0 = a release ON an enabled label · hop 1 = an artist on such a release
//   hop 2 = a release that artist ALSO appears on · then STOP (a configurable limit).
// A node at `hop > maxHop` is never enqueued, so the walk terminates by construction.
//
// ── RELIABILITY: the shipped `backfill_*` convention, verbatim ─────────────────
// `attempted_at` / `attempts` / `failures` / `done_at` mean exactly what they mean on
// `findings` (see the backfill columns there): a FAILED node backs off exponentially on
// its consecutive-failure count and is retried by a later tick; past MAX_FAILURES it
// stays `failed` and is never picked again. `cursor` is the browse OFFSET a paginated
// node (a label's or an artist's release list) has consumed — a node with more pages
// stays `pending` with an advanced cursor, so a 900-release label drains across ticks
// instead of blowing one. `parent_id` records the edge that discovered the node, so a
// bad subtree is traceable (and prunable); `label_slug` carries the enabled seed the
// whole subtree descends from.
//
// `id` is DETERMINISTIC — `<source>:<kind>:<external_id>` — which is what makes the
// crawl idempotent at the graph level: re-discovering a node the walk already holds is
// an `on conflict do nothing`, not a second traversal of the same subtree.
export const crawlFrontier = sqliteTable(
  "crawl_frontier",
  {
    attemptedAt: text("attempted_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),
    // The browse offset already consumed (paginated `label` / `artist` nodes only).
    cursor: integer("cursor").notNull().default(0),
    // THE DEMAND REORDER (docs/catalogue-crawler.md § Demand). 0 = a node belonging to an
    // entity real visitors looked at (its seed label's subtree, via `label_slug`, or an
    // artist node matched by MBID); 1 = every other node. Written ONLY by the `record_demand`
    // op (clear-all-to-1 then set-0). The pick order is `(state, hop, demand_rank, created_at,
    // id)`, so demand only REORDERS WITHIN A HOP — breadth-first by hop is preserved, and a
    // ruled-out label never becomes a seed node, so demand can never resurrect one.
    demandRank: integer("demand_rank").notNull().default(1),
    doneAt: text("done_at"),
    // The MB entity's MBID — or, for a seed `label` node, the operator's `labels.slug`.
    externalId: text("external_id").notNull(),
    failures: integer("failures").notNull().default(0),
    hop: integer("hop").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["artist", "label", "release"] }).notNull(),
    // The enabled seed label this node's subtree descends from (provenance + pruning).
    labelSlug: text("label_slug"),
    // Why a node was skipped or how it last failed — the crawl's honest audit trail.
    note: text("note"),
    parentId: text("parent_id"),
    source: text("source", { enum: ["fluncle", "musicbrainz"] }).notNull(),
    // pending → done (expanded) | failed (retriable under backoff, terminal past
    // MAX_FAILURES) | skipped (deterministically un-expandable — e.g. no MB label
    // matches the operator's spelling; recorded rather than retried forever).
    state: text("state", { enum: ["done", "failed", "pending", "skipped"] })
      .notNull()
      .default("pending"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // The pick: `where state in (…) order by hop, demand_rank, created_at, id` — breadth-first
    // and deterministic, so two runs over the same graph expand the same nodes in the same
    // order. `demand_rank` sits AFTER `hop` (a within-hop tiebreak only: a demanded node is
    // picked before an undemanded sibling at the same hop, never ahead of a nearer hop), so
    // the demand reorder cannot break breadth-first. Leading with `state` keeps a drained
    // frontier's tick a cheap no-op.
    index("crawl_frontier_pick_idx").on(
      table.state,
      table.hop,
      table.demandRank,
      table.createdAt,
      table.id,
    ),
    // The per-seed status read (and the subtree prune, when one is needed).
    index("crawl_frontier_label_idx").on(table.labelSlug),
  ],
);

// A newsletter EDITION — the weekly dispatch from the mothership, now persisted so
// every Friday letter has a permanent home.
// Modeled on the `mixtapes` table SHAPE (own table + counter + a draft→sent
// lifecycle) but NOT its identity: an edition is content, not a collectible, so its
// identity is a plain integer `number` minted on send (`max(number)+1`) — NO Log
// ID, no coordinate, no spine resolver branch. The stored `contentJson` is the
// single source that renders BOTH the web archive page and the email HTML.
export const editions = sqliteTable("editions", {
  // RSS/index ordering — set on send.
  addedAt: text("added_at"),
  // The structured JSON payload the agent authors (intro, galaxy-grouped finding
  // refs by logId + per-edition "why", the optional mixtape ref, the tidbits +
  // sources, the window, the subject). NOT raw LMX — the web page and the email
  // HTML both render FROM this one source. Stored as JSON text.
  contentJson: text("content_json").notNull(),
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  // The sequential edition number — minted on send (`max(number)+1`), null while a
  // draft. A plain integer never exhausts (no cap-54 like the mixtape spine).
  number: integer("number").unique(),
  // PROVENANCE — the `newsletter_edition` prompt version this edition was authored
  // under (docs/agents/prompt-registry.md). NULL for an operator-written draft or an
  // agent fallback to the baked-in default; `0` is the registry default; a number is
  // the live `prompt_versions.version`.
  promptVersion: integer("prompt_version"),
  // Provenance of the send so a re-send is idempotent and the archive records how
  // it went out. "resend" + the Resend broadcast id.
  sendExternalId: text("send_external_id"),
  sendProvider: text("send_provider"),
  sentAt: text("sent_at"),
  status: text("status", { enum: ["draft", "sent"] })
    .notNull()
    .default("draft"),
  subject: text("subject"),
  updatedAt: text("updated_at").notNull(),
  // The discovery window this edition covered — `windowUntil` anchors the next
  // window's self-heal (the agent reads the last SENT edition's cutoff).
  windowSince: text("window_since"),
  windowUntil: text("window_until"),
});

// The operator's private cost ledger (COST-02) — the single source of truth for
// Fluncle's recurring + one-off spend. It was pulled from the public repo docs on
// purpose: vendor names and amounts are the operator's private data, so they live
// in the DB at runtime, never in a committed file. The `/admin/costs` station is
// operator-tier; the table ships EMPTY (no seed) and the operator fills it in-app.
export const subscriptions = sqliteTable("subscriptions", {
  // The charge in minor units (cents) — an integer never drifts the way a float
  // does. A one-off or usage line still records its last/expected amount here.
  amount: integer("amount").notNull(),
  // A billing dashboard / invoice URL, so the operator can jump straight to the
  // vendor's account page from the row. Nullable.
  billingUrl: text("billing_url"),
  // How the charge recurs: a monthly/annual subscription, a single one-off, or a
  // metered usage line (variable, amount is the running/estimate).
  cadence: text("cadence", { enum: ["monthly", "annual", "one-off", "usage"] }).notNull(),
  // What bucket the spend falls in — a small closed set so the ledger totals by
  // category. A CHECK constraint (drizzle's typed enum) keeps a typo out.
  category: text("category", {
    enum: ["infra", "AI", "media", "distribution", "domains", "tooling"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
  // ISO 4217. Fluncle bills across a few currencies; store each line's own.
  currency: text("currency").notNull().default("EUR"),
  id: text("id").primaryKey(),
  // The human name of the line item (e.g. the plan/product name).
  name: text("name").notNull(),
  // A free-text operator note — anything worth remembering about the line.
  notes: text("notes"),
  // Which Fluncle surface or cron this spend powers — the "what breaks if I cancel
  // it" link back to the system. Nullable free text.
  powers: text("powers"),
  // ISO date of the next renewal/charge, when known. Null for a one-off or an
  // untracked cadence.
  renewsAt: text("renews_at"),
  // Lifecycle: an active line, a cancelled one (kept for the record), or a trial.
  status: text("status", { enum: ["active", "cancelled", "trial"] })
    .notNull()
    .default("active"),
  updatedAt: text("updated_at").notNull(),
  // The vendor/provider the money goes to (e.g. Cloudflare, Anthropic).
  vendor: text("vendor").notNull(),
});

// A tiny once-a-day cache of foreign-exchange reference rates (ECB, via the free
// keyless Frankfurter API), so the Costs ledger can show ONE aggregate "what you pay
// today" figure in EUR without converting each fixed-price line. A singleton row keyed
// by `base` ("EUR"): `ratesJson` maps EUR→currency (e.g. { "USD": 1.18 }); `ratesDate`
// is the ECB publish date; `fetchedAt` gates the read-through refresh (>12h ⇒ refetch).
export const exchangeRates = sqliteTable("exchange_rates", {
  base: text("base").primaryKey(),
  fetchedAt: text("fetched_at").notNull(),
  ratesDate: text("rates_date").notNull(),
  ratesJson: text("rates_json").notNull(),
});
