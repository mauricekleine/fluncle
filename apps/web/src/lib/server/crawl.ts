// THE CATALOGUE CRAWLER — Fluncle's acquisition of METADATA, and nothing else.
//
// It walks the MusicBrainz release graph outward from the labels the operator ENABLED
// and writes catalogue rows into `tracks`. It never writes a `findings` row, because it
// cannot certify anything: certification is a relationship Fluncle has with a track, and
// a crawler has no ears. That firewall is structural, not a rule to remember — this
// module contains no `insert into findings`, and the certification test proves a crawled
// track is invisible to `/log`, the feeds, the sitemap and the Galaxy (see
// findings-certification.integration.test.ts). It does not capture audio either: the row
// simply lands with `capture_status` at its DDL default, and a separate, operator-gated
// pipeline decides whether the bytes are ever fetched.
//
// ── THE BOUNDARY GATE: seed-label allowlist + graph distance ────────────────────
// There is NO genre inference here — no MusicBrainz tag, no Discogs style, no BPM band.
// The operator already drew the boundary when he ruled on the labels (`labels.seed_state`,
// docs/label-entity.md). The crawler's only job is to not leave the neighbourhood:
//
//   hop 0 — a release on a label whose `seed_state` is `enabled`
//   hop 1 — an artist who appears on such a release
//   hop 2 — a release that artist ALSO appears on
//   …and STOP at `maxHop` (default 2). A node past the limit is never enqueued, so
//   the walk terminates by construction rather than by a watchdog.
//
// A label the walk DISCOVERS that nobody has ruled on enters as `undecided` (the
// `labels` DDL default) and surfaces in the operator's attention queue. It is NOT
// crawled — a subsequent crawl seeds from it only once the operator enables it. That is
// the self-widening-but-operator-ratified loop: the crawler proposes, the operator rules.
//
// ── WHY MUSICBRAINZ CARRIES THE WALK ───────────────────────────────────────────
// MusicBrainz is the only one of the three sources that is RECORDING-centric, which is
// what a track-level catalogue needs: label → releases → recordings (with ISRCs) →
// artist credits → their other releases is a clean, complete, paginated graph, CC0, and
// free of a token. Discogs is RELEASE-centric — it has no recording entity and no ISRCs,
// so it cannot supply a stable track identity and cannot be the spine. We still reach
// the Discogs release graph, but through the join that already exists: MusicBrainz's
// CURATED `url-rels` relation, which hands us the Discogs release/master id for free, in
// the same request that brought the tracks, with zero Discogs API calls. Spotify is
// demoted to a per-track ISRC lookup for the `spotify_uri`/`spotify_url` anchor (its
// Feb-2026 lockdown removed the batch endpoints and capped `search` at 10 results), and
// that anchor is optional — a track with no Spotify presence is a perfectly good row. It
// runs as its own bounded step (`fillSpotifyAnchors`), NOT inside the walk: the first
// pilot put it in the write path and Spotify 429'd. Its queue is DERIVED, so nothing is
// lost when it is throttled.
//
// ── DETERMINISTIC · RESUMABLE · POLITE · IDEMPOTENT ────────────────────────────
//   Deterministic — the frontier is picked `order by hop, created_at, id`, so two runs
//     over the same graph expand the same nodes in the same order.
//   Resumable — every scrap of walk state lives in `crawl_frontier` (docs/, schema.ts),
//     never in a process. A tick that dies mid-label is RESUMED by the next one: the
//     node it was on is still `pending` with its browse cursor where it got to.
//   Polite — every MB call goes through the ONE shared client (./musicbrainz.ts): an
//     identifiable User-Agent, ~1 req/s, `Retry-After` honoured on a 503. An exhausted
//     503 trips the run's circuit breaker (`rateLimited`) and the pass STOPS — it does
//     not grind the same wall. Same discipline as the shipped `fluncle-backfill` sweep.
//   Idempotent — a track is deduped on ISRC where MusicBrainz has one, else on its MB
//     recording id (which IS the minted `track_id`, `mb_<uuid>`). A re-crawl of the same
//     graph writes ZERO new rows.
//
// See docs/catalogue-crawler.md.

import { linkTracksToArtistEntities } from "./artists";
import { getDb, typedRows } from "./db";
import { parseDiscogsUrl } from "./discogs";
import { setLabelMbLabelId } from "./label-images";
import { ensureLabel, labelSlug, listLabels } from "./labels";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { findSpotifyTrackByIsrc } from "./spotify";

// ── Policy constants ─────────────────────────────────────────────────────────

/** The ratified default: label → release → artist → release, then stop. */
export const DEFAULT_MAX_HOP = 2;

/** A hard ceiling on the configurable limit — past 3 the walk is the whole of music. */
export const MAX_HOP_CEILING = 3;

/** MusicBrainz's browse page size ceiling. One page = one request. */
const BROWSE_PAGE_SIZE = 100;

/** Consecutive failures after which a node is abandoned (stays `failed`, never picked). */
const MAX_FAILURES = 5;

/**
 * Spotify anchors filled per pass. Small on purpose: Spotify's 429 is a hard wall (the
 * pilot hit it), the anchor is a nicety rather than the point, and the queue is derived —
 * so whatever this tick misses, the next one picks up. `fillSpotifyAnchors` explains why.
 */
const ANCHOR_BUDGET = 20;

// The retry window for a FAILED node, growing with its consecutive-failure count — the
// shipped `backfill_*` backoff, verbatim in shape (backfill.ts): base × 2^failures,
// capped, so a node the vendor keeps throttling backs off hard instead of being retried
// every tick. Shorter base than the backfill's 24h because a crawl node's failure is
// usually transient (a 503), not a settled no-match.
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * MusicBrainz's "Various Artists" placeholder. It is credited on every compilation ever
 * pressed, so following it as a hop-1 artist would walk the crawler straight out of drum
 * & bass and into the entire recorded-music graph in a single step. The one hard-coded
 * exclusion in the walk — and it is an IDENTITY exclusion, not a genre judgement.
 */
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

// ── Types ────────────────────────────────────────────────────────────────────

export type CrawlNodeKind = "artist" | "label" | "release";
export type CrawlNodeState = "done" | "failed" | "pending" | "skipped";
export type CrawlNodeSource = "fluncle" | "musicbrainz";

type FrontierRow = {
  cursor: number;
  external_id: string;
  failures: number;
  hop: number;
  id: string;
  kind: CrawlNodeKind;
  label_slug: string | null;
  source: CrawlNodeSource;
};

/** One catalogue track the walk found on a release, before it meets the archive. */
type TrackCandidate = {
  album: string | null;
  albumImageUrl: string | null;
  artists: string[];
  durationMs: number;
  inMasterId: number | null;
  inReleaseId: number | null;
  isrc: string | null;
  label: string | null;
  recordingId: string;
  releaseDate: string | null;
  title: string;
};

/** What one `crawl_catalogue` pass did. Every number here is real, not an estimate. */
export type CrawlPass = {
  /** Spotify `spotify_uri`/`spotify_url` anchors filled onto existing catalogue rows. */
  anchorsFilled: number;
  dryRun: boolean;
  /** Frontier nodes expanded this pass. */
  expanded: number;
  /** Frontier nodes that failed (a vendor error) and were backed off. */
  failed: number;
  /** Nodes still waiting after this pass — 0 means the reachable graph is drained. */
  frontierPending: number;
  /** Labels the walk discovered and minted as `undecided` (the operator's next ruling). */
  labelsDiscovered: string[];
  maxHop: number;
  /** New frontier nodes this pass enqueued (the walk's outward edge). */
  nodesEnqueued: number;
  /** True when MusicBrainz actively throttled us and the pass STOPPED on the breaker. */
  rateLimited: boolean;
  /** Seed nodes minted from the operator's `enabled` labels this pass. */
  seeded: number;
  /** Catalogue tracks the walk SAW on the releases it expanded. */
  tracksFound: number;
  /** Tracks already in the archive (by ISRC, or by MB recording id) — the idempotence. */
  tracksSkipped: number;
  /** Catalogue rows actually written into `tracks`. Never a `findings` row. */
  tracksWritten: number;
};

/** The frontier's shape at rest — the `get_crawl_status` read. */
export type CrawlStatus = {
  /** Catalogue rows with an ISRC still awaiting their Spotify anchor (the derived queue). */
  anchorsPending: number;
  /** Catalogue tracks in the archive: `tracks` rows with NO `findings` row. */
  catalogueTracks: number;
  /** Every distinct label the walk has minted but nobody has ruled on yet. */
  labelsUndecided: number;
  /** Frontier node counts, grouped `<state>` and `<state>:<kind>`. */
  frontier: { done: number; failed: number; pending: number; skipped: number };
  frontierByKind: { artist: number; label: number; release: number };
  /** The operator's enabled seed labels — what the NEXT crawl would seed from. */
  seedLabels: string[];
};

// ── MusicBrainz response shapes (only the fields we consume) ──────────────────

type MbArtistCredit = { artist?: { id?: string; name?: string }; name?: string };
type MbRecording = {
  "artist-credit"?: MbArtistCredit[];
  id?: string;
  isrcs?: string[];
  length?: null | number;
  title?: string;
};
type MbTrack = { length?: null | number; recording?: MbRecording; title?: string };
type MbMedium = { tracks?: MbTrack[] };
type MbRelation = { type?: string; url?: { resource?: string } };
type MbLabelInfo = { label?: { id?: string; name?: string } | null };
type MbReleaseDetail = {
  "artist-credit"?: MbArtistCredit[];
  "cover-art-archive"?: { front?: boolean };
  date?: string;
  id?: string;
  "label-info"?: MbLabelInfo[];
  media?: MbMedium[];
  relations?: MbRelation[];
  title?: string;
};
type MbReleaseBrowse = { "release-count"?: number; releases?: { id?: string }[] };
type MbLabelSearch = { labels?: { id?: string; name?: string; score?: number }[] };

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * A frontier node's DETERMINISTIC id. Re-discovering a node the walk already holds is
 * then an `on conflict do nothing`, not a second traversal of the same subtree — which
 * is what keeps a graph with cycles (and the release graph is full of them: two artists
 * on one release each point back at it) from looping forever.
 */
function frontierId(source: CrawlNodeSource, kind: CrawlNodeKind, externalId: string): string {
  return `${source}:${kind}:${externalId}`;
}

/**
 * A crawled track's `track_id`. `tracks.track_id` is an opaque PK that HAPPENS to be the
 * Spotify id for a finding; a catalogue track mints its own from the identity that
 * actually exists for it — the MusicBrainz recording MBID. Deterministic, so re-crawling
 * the same recording collides on the primary key and writes nothing.
 */
export function catalogueTrackId(recordingMbid: string): string {
  return `mb_${recordingMbid}`;
}

/**
 * Fold a label name to its comparable core: lowercase, alphanumerics only, no spaces or
 * punctuation at all. This is deliberately aggressive, because label names are the single
 * dirtiest string in the archive and the two spellings that must fold together are
 * exactly the ones a gentler normalizer keeps apart:
 *
 *   "Medschool" (the operator's) ⇄ "Med School" (MusicBrainz's) — VERIFIED live, and the
 *   reason the first pilot crawl found nothing.
 *   "Pilot." ⇄ "Pilot" · "R.O.A.M" ⇄ "ROAM"
 *
 * Equality of this fold is still an EXACT match — it never accepts "Shogun Records" for
 * "Shogun Audio". And when two MB labels fold the same (there are two "Hospital Records",
 * London and US), the first — MusicBrainz returns them score-ordered — wins, so the
 * choice is deterministic rather than arbitrary.
 */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// ── Frontier persistence ─────────────────────────────────────────────────────

/**
 * Enqueue a node, unless the frontier already holds it. `on conflict do nothing` is the
 * whole cycle guard: an artist reached from two different releases is ONE node.
 * Returns 1 when a node was actually minted.
 */
async function enqueue(node: {
  externalId: string;
  hop: number;
  kind: CrawlNodeKind;
  labelSlug: string | null;
  parentId: string | null;
  source: CrawlNodeSource;
}): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.execute({
    args: [
      frontierId(node.source, node.kind, node.externalId),
      node.kind,
      node.source,
      node.externalId,
      node.hop,
      node.parentId,
      node.labelSlug,
      now,
      now,
    ],
    sql: `insert into crawl_frontier
            (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do nothing`,
  });

  return result.rowsAffected;
}

/** Record how a node's expansion ended. The durable state the next tick resumes from. */
async function settle(
  id: string,
  state: CrawlNodeState,
  patch: { cursor?: number; failures?: number; note?: string } = {},
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [
      state,
      state === "done" ? now : null,
      patch.cursor ?? 0,
      patch.failures ?? 0,
      patch.note ?? null,
      now,
      now,
      id,
    ],
    sql: `update crawl_frontier
          set state = ?, done_at = ?, cursor = ?, failures = ?, note = ?,
              attempts = attempts + 1, attempted_at = ?, updated_at = ?
          where id = ?`,
  });
}

/**
 * The pass's pick: the next `limit` nodes to expand, BREADTH-FIRST and deterministic
 * (`hop, created_at, id`). It takes `pending` nodes plus `failed` ones whose exponential
 * backoff has elapsed and which have not yet been abandoned — so a transient 503 is
 * retried by a later tick instead of silently pruning a subtree.
 */
async function pickNodes(limit: number): Promise<FrontierRow[]> {
  const db = await getDb();
  const now = Date.now();
  // One cutoff per failure count, computed here rather than in SQL: SQLite has no clean
  // exponential, and an ISO string comparison is exact.
  const cutoff = (failures: number): string =>
    new Date(now - Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)).toISOString();

  const result = await db.execute({
    args: [MAX_FAILURES, cutoff(1), cutoff(2), cutoff(3), cutoff(4), limit],
    sql: `select id, kind, source, external_id, hop, cursor, failures, label_slug
          from crawl_frontier
          where state = 'pending'
             or (state = 'failed'
                 and failures < ?
                 and attempted_at <= (case failures
                                        when 1 then ?
                                        when 2 then ?
                                        when 3 then ?
                                        else ? end))
          order by hop asc, created_at asc, id asc
          limit ?`,
  });

  return typedRows<FrontierRow>(result.rows);
}

/**
 * THE ARCHIVE'S OWN SPELLING of a label MusicBrainz just handed us — or `undefined` if it
 * has never heard of it. Two jobs ride on this one lookup, and both are load-bearing.
 *
 * The problem it solves is real and the pilot found it twice: the operator's archive spells
 * the label **"Medschool"**; MusicBrainz spells it **"Med School"**. They fold to the same
 * label and they slugify to two different slugs (`medschool` vs `med-school`).
 *
 * 1. THE ATTENTION QUEUE. A slug check would mint a SECOND `labels` row for a label he has
 *    already ruled on, and drop it in his queue asking him to rule on it again. The queue
 *    is his steering wheel; filling it with the crawler's own spelling variants blunts it.
 *    Fold-equal ⇒ already known ⇒ say nothing.
 *
 * 2. THE CAPTURE-PRIORITY LADDER (docs/the-ear.md), and this one is sharper. The Ear keys
 *    every label rung on `slugify(tracks.label) = labels.slug`. If the crawler wrote MB's
 *    spelling onto the row, `med-school` would match no label, so the "its label carries a
 *    finding" and "its label is one he seeds from" rungs would NEVER FIRE on a crawled
 *    track — and, far worse, neither would the `skipped-label` VETO, the rung whose whole
 *    job is to stop the metered capture budget being spent on a label he ruled out.
 *    Measured: before this, a full Medschool crawl produced 223 rows at tier 3 and 512 at
 *    tier 0, with NOTHING at tiers 1 or 2. The ladder was silently half-dead.
 *
 * So the crawler writes back the name the ARCHIVE uses, not the name the vendor used. That
 * is not a loss of provenance — the row's MB identity is its `track_id` — it is what makes
 * `slugify(tracks.label) = labels.slug` true by construction for every crawled row, which
 * is the invariant every label consumer already assumes.
 *
 * A genuinely NEW label is returned `undefined`; the caller then mints the row from MB's
 * spelling and writes that same spelling onto the track, so the two agree by construction.
 *
 * Bounded: `labels` holds one row per DISTINCT label (tens), never one per track.
 */
async function canonicalLabelName(name: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute("select name from labels");
  const want = fold(name);

  return typedRows<{ name: string }>(result.rows).find((row) => fold(row.name) === want)?.name;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Mint a seed node for every label the operator ENABLED. This is the ONE place the crawl
 * reads `labels.seed_state`, and it reads it for exactly the question the column answers:
 * may the next crawl seed from this label? A `disabled` or `undecided` label is simply
 * not seeded — nothing already stored is touched, hidden, or removed (docs/label-entity.md).
 *
 * Idempotent: re-seeding an already-seeded label is a no-op, so an operator enabling a new
 * label mid-crawl just adds one node to the frontier on the next tick.
 */
async function seedFromEnabledLabels(): Promise<{ minted: number; slugs: string[] }> {
  const enabled = await listLabels("enabled");
  let minted = 0;

  for (const label of enabled) {
    minted += await enqueue({
      externalId: label.slug,
      hop: 0,
      kind: "label",
      labelSlug: label.slug,
      parentId: null,
      source: "fluncle",
    });
  }

  return { minted, slugs: enabled.map((label) => label.slug) };
}

// ── The writes ───────────────────────────────────────────────────────────────

/**
 * Write a release's tracks into `tracks` as CATALOGUE rows — and nowhere near `findings`.
 *
 * IDEMPOTENCE, in two layers, because one is not enough:
 *   1. A bounded pre-read over the candidates' ISRCs + minted ids (`tracks_isrc_idx`).
 *      An ISRC is the recording's real identity, so a track Fluncle already CERTIFIED —
 *      whose `track_id` is a Spotify id, not `mb_…` — is recognised and skipped. Without
 *      this the crawler would happily mint a second, uncertified row for a finding.
 *   2. `on conflict (track_id) do nothing` on the insert, which closes the race the
 *      pre-read cannot (two ticks, same recording) at the primary key.
 *
 * `capture_status` and every other queue column are simply never named: the DDL defaults
 * land, the row is nobody's work item, and no agent sweep can reach it (the enrichment,
 * note, observe and video queues all live on `findings`, which this row does not have).
 */
async function writeCatalogueTracks(
  candidates: TrackCandidate[],
): Promise<{ skipped: number; written: number; writtenIds: string[] }> {
  if (candidates.length === 0) {
    return { skipped: 0, written: 0, writtenIds: [] };
  }

  const db = await getDb();
  const ids = candidates.map((candidate) => catalogueTrackId(candidate.recordingId));
  const isrcs = candidates
    .map((candidate) => candidate.isrc)
    .filter((isrc): isrc is string => Boolean(isrc));

  const existing = await db.execute({
    args: [...ids, ...isrcs],
    sql: `select track_id, isrc from tracks
          where track_id in (${ids.map(() => "?").join(", ")})
          ${isrcs.length > 0 ? `or isrc in (${isrcs.map(() => "?").join(", ")})` : ""}`,
  });

  const heldIds = new Set<string>();
  const heldIsrcs = new Set<string>();

  for (const row of typedRows<{ isrc: null | string; track_id: string }>(existing.rows)) {
    heldIds.add(row.track_id);

    if (row.isrc) {
      heldIsrcs.add(row.isrc);
    }
  }

  let written = 0;
  let skipped = 0;
  const writtenIds: string[] = [];

  for (const candidate of candidates) {
    const trackId = catalogueTrackId(candidate.recordingId);

    if (heldIds.has(trackId) || (candidate.isrc && heldIsrcs.has(candidate.isrc))) {
      skipped += 1;
      continue;
    }

    // NO Spotify call here. The anchor is filled by `fillSpotifyAnchors` on its own
    // bounded, resumable budget — see that function's header for why the pilot forced it
    // out of this hot path.
    const result = await db.execute({
      args: [
        trackId,
        candidate.title,
        JSON.stringify(candidate.artists),
        candidate.durationMs,
        candidate.album,
        candidate.albumImageUrl,
        candidate.isrc,
        candidate.label,
        candidate.releaseDate,
        candidate.inReleaseId,
        candidate.inMasterId,
      ],
      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, album_image_url, isrc,
               label, release_date, in_release_id, in_master_id)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (track_id) do nothing`,
    });

    if (result.rowsAffected > 0) {
      written += 1;
      writtenIds.push(trackId);
      heldIds.add(trackId);

      if (candidate.isrc) {
        heldIsrcs.add(candidate.isrc);
      }
    } else {
      skipped += 1;
    }
  }

  return { skipped, written, writtenIds };
}

/**
 * Stamp `tracks.label_id` on the rows this release just wrote — the indexed edge the public
 * `/label/<slug>` page reads by (docs/label-entity.md), which shows every track on a label,
 * certified or not. One resolve + one batched UPDATE per RELEASE, never per track.
 *
 * The deploy-time `linkTracksToLabels` backfill already names "a future catalogue crawler"
 * as a writer it self-heals, and it does. But a crawl ticks every ten minutes and a deploy
 * does not, so a crawled row would sit off its label's page until the next one. This closes
 * that window; the backfill stays the backstop.
 *
 * It resolves by `slugify(label)`, which is exactly why the crawler writes the ARCHIVE's
 * spelling of a label it already knows (`canonicalLabelName`) rather than MusicBrainz's:
 * `Med School` would slug to `med-school` and point at nothing.
 *
 * ALBUMS are deliberately NOT linked here. An album row is minted only off a CERTIFIED
 * finding (`reconcileAlbums`) — it earns an entity, a page and a sitemap slot because
 * Fluncle found something on it — so the crawler must never mint one. Linking a crawled
 * track to an album that already exists is pure upside and costs nothing to defer, so the
 * deploy backfill (`linkTracksToAlbums`, which skips an absent album) owns it alone.
 */
async function linkTracksToLabel(trackIds: string[], labelName: string): Promise<void> {
  const slug = labelSlug(labelName);

  if (!slug || trackIds.length === 0) {
    return;
  }

  const db = await getDb();
  const found = await db.execute({
    args: [slug],
    sql: `select id from labels where slug = ? limit 1`,
  });
  const labelId = typedRows<{ id: string }>(found.rows)[0]?.id;

  if (!labelId) {
    return;
  }

  await db.execute({
    args: [labelId, ...trackIds],
    sql: `update tracks set label_id = ?
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
}

/**
 * THE SPOTIFY ANCHOR — a bounded, resumable gap-fill, and deliberately NOT part of the
 * write path.
 *
 * The first live pilot put the by-ISRC lookup inline in the release write, and Spotify
 * 429'd once the volume climbed — a whole release's worth of tracks landing with no
 * anchor and no way to ever get one, because the crawler never revisits a row it wrote.
 * Two lessons, both structural:
 *
 *   1. A per-track vendor lookup does not belong in a graph walk. It has its own rate
 *      budget, its own failure mode, and its own retry semantics. It gets its own step.
 *   2. The queue must be DERIVED, not remembered — `isrc is not null and spotify_uri is
 *      null` IS the worklist, so an anchor missed under a 429 is simply picked up by the
 *      next tick. Nothing is lost, nothing is bookkept. (`tracks_anchor_queue_idx` is a
 *      PARTIAL index over exactly that predicate, so the queue read stays cheap as the
 *      catalogue grows — and the index SHRINKS as the anchors fill.)
 *
 * The breaker: the first 429 stops the fill for this pass. Spotify is the one vendor here
 * whose 429 is a hard wall rather than a slow-down, and grinding it just earns a longer
 * ban. The rows are already written; the anchor is a nicety, and it can wait ten minutes.
 *
 * Findings are excluded (the anti-join): a certified track's Spotify id is its identity
 * and was written at publish. This only ever touches catalogue rows.
 */
async function fillSpotifyAnchors(limit: number): Promise<{ filled: number; throttled: boolean }> {
  const db = await getDb();
  const queue = await db.execute({
    args: [limit],
    sql: `select track_id, isrc from tracks
          where isrc is not null
            and spotify_uri is null
            and not exists (select 1 from findings where findings.track_id = tracks.track_id)
          order by track_id
          limit ?`,
  });

  let filled = 0;

  for (const row of typedRows<{ isrc: string; track_id: string }>(queue.rows)) {
    const { match, rateLimited } = await findSpotifyTrackByIsrc(row.isrc);

    if (rateLimited) {
      logEvent("warn", "crawl.spotify-throttled", { filled });

      return { filled, throttled: true };
    }

    if (!match) {
      // Genuinely not on Spotify. A real, unremarkable answer — and the row stays in the
      // queue, which is the honest trade: we would rather re-ask than mint a wrong anchor
      // or a "we checked" column nobody reads.
      continue;
    }

    await db.execute({
      args: [match.spotifyUri, match.spotifyUrl, match.albumImageUrl ?? null, row.track_id],
      sql: `update tracks
            set spotify_uri = ?, spotify_url = ?, album_image_url = coalesce(album_image_url, ?)
            where track_id = ?`,
    });
    filled += 1;
  }

  return { filled, throttled: false };
}

// ── Node expansion ───────────────────────────────────────────────────────────

/** What one node's expansion produced, before the pass folds it in. */
type Expansion = {
  enqueued: number;
  labelsDiscovered: string[];
  next: { cursor: number; state: CrawlNodeState; note?: string };
  tracksFound: number;
  tracksSkipped: number;
  tracksWritten: number;
};

const EMPTY: Expansion = {
  enqueued: 0,
  labelsDiscovered: [],
  next: { cursor: 0, state: "done" },
  tracksFound: 0,
  tracksSkipped: 0,
  tracksWritten: 0,
};

/** Thrown when MusicBrainz is actively throttling — the pass's circuit breaker. */
class ThrottledError extends Error {}

/** One MB call, with the run-level breaker wired in. */
async function mb<T>(path: string): Promise<T | null> {
  const { data, rateLimited } = await mbFetch<T>(path);

  if (rateLimited) {
    throw new ThrottledError(`MusicBrainz is rate-limiting (${path})`);
  }

  return data;
}

/**
 * A SEED label node (the operator's slug) → the MusicBrainz label entity.
 *
 * Resolution is its own graph step, and that is deliberate: it makes the (fallible,
 * rate-limited) name→MBID lookup RESUMABLE and recorded, instead of a lookup repeated
 * on every tick. A label MusicBrainz does not know is `skipped` with a reason — recorded
 * honestly, never retried forever, and visible in `get_crawl_status`.
 */
async function expandSeedLabel(node: FrontierRow): Promise<Expansion> {
  const labels = await listLabels("enabled");
  const label = labels.find((candidate) => candidate.slug === node.external_id);

  if (!label) {
    // The operator disabled it since the seed was minted. Crawl scope is the next
    // crawl's seed set — so we simply stop walking it. Nothing stored is touched.
    return { ...EMPTY, next: { cursor: 0, note: "label no longer enabled", state: "skipped" } };
  }

  // A FREE-TEXT query, not a field-scoped exact phrase: `label:"Medschool"` returns
  // nothing (MusicBrainz spells it "Med School"), while the free-text search returns it
  // at score 100. Verified live. The exactness lives in the fold, not in the query.
  const search = await mb<MbLabelSearch>(`/label?query=${encodeURIComponent(label.name)}&limit=5`);
  const want = fold(label.name);
  const match = (search?.labels ?? []).find(
    (candidate) => candidate.id && candidate.name && fold(candidate.name) === want,
  );

  if (!match?.id) {
    return {
      ...EMPTY,
      next: { cursor: 0, note: "no exact MusicBrainz label match", state: "skipped" },
    };
  }

  // Persist the MBID the walk already resolved — the label-image sweep reads it to skip its own
  // MB search (and it is the label's durable KG anchor). Non-clobbering + best-effort: it never
  // fights the sweep and a failure here must not derail the crawl. See label-images.ts.
  await setLabelMbLabelId(label.slug, match.id).catch((error) => {
    logEvent("warn", "crawl.persist-mb-label-id-failed", { error, slug: label.slug });
  });

  const enqueued = await enqueue({
    externalId: match.id,
    hop: 0,
    kind: "label",
    labelSlug: label.slug,
    parentId: node.id,
    source: "musicbrainz",
  });

  return { ...EMPTY, enqueued };
}

/**
 * A MusicBrainz label (or artist) node → one page of its releases, as `release` nodes.
 *
 * ONE request per tick per node. A label with 900 releases stays `pending` with its
 * browse cursor advanced, so it drains across ticks instead of blowing a single one — the
 * resumability that matters most in practice, because the biggest seed label is also the
 * one most likely to be interrupted.
 */
async function expandBrowse(node: FrontierRow, maxHop: number): Promise<Expansion> {
  const childHop = node.kind === "label" ? 0 : node.hop + 1;

  if (childHop > maxHop) {
    return { ...EMPTY, next: { cursor: 0, note: `hop limit ${maxHop}`, state: "done" } };
  }

  const key = node.kind === "label" ? "label" : "artist";
  const browse = await mb<MbReleaseBrowse>(
    `/release?${key}=${node.external_id}&limit=${BROWSE_PAGE_SIZE}&offset=${node.cursor}`,
  );
  const releases = (browse?.releases ?? []).filter(
    (release): release is { id: string } => typeof release.id === "string",
  );

  let enqueued = 0;

  for (const release of releases) {
    enqueued += await enqueue({
      externalId: release.id,
      hop: childHop,
      kind: "release",
      labelSlug: node.label_slug,
      parentId: node.id,
      source: "musicbrainz",
    });
  }

  const consumed = node.cursor + releases.length;
  const total = browse?.["release-count"] ?? consumed;
  const hasMore = releases.length === BROWSE_PAGE_SIZE && consumed < total;

  return {
    ...EMPTY,
    enqueued,
    next: { cursor: hasMore ? consumed : 0, state: hasMore ? "pending" : "done" },
  };
}

/**
 * A release node → THE WRITE. One request brings the whole release: its tracks, their
 * recordings (with MBIDs and ISRCs), the artist credits, the label, and — for free, in
 * the same payload — MusicBrainz's curated Discogs `url-rels` relation, which is how the
 * catalogue reaches the Discogs release graph without a single Discogs API call.
 *
 * It also mints a `labels` row for the release's label. THAT is the widening loop: a
 * label nobody has ruled on enters `undecided` and lands in the operator's attention
 * queue. It does not get crawled until he enables it.
 */
async function expandRelease(node: FrontierRow, maxHop: number): Promise<Expansion> {
  const release = await mb<MbReleaseDetail>(
    `/release/${node.external_id}?inc=recordings+artist-credits+isrcs+labels+url-rels`,
  );

  if (!release?.id) {
    return { ...EMPTY, next: { cursor: 0, note: "no MusicBrainz release", state: "skipped" } };
  }

  // The Discogs ids, straight off MusicBrainz's curated relation. Never guessed.
  let inReleaseId: null | number = null;
  let inMasterId: null | number = null;

  for (const relation of release.relations ?? []) {
    const resource = relation.url?.resource;
    const parsed = relation.type === "discogs" && resource ? parseDiscogsUrl(resource) : undefined;

    if (parsed?.kind === "release") {
      inReleaseId = parsed.id;
    } else if (parsed?.kind === "master") {
      inMasterId = parsed.id;
    }
  }

  const mbLabelName = (release["label-info"] ?? []).find((info) => info.label?.name)?.label?.name;
  const labelsDiscovered: string[] = [];
  // The name we WRITE onto the track: the archive's own spelling when it already knows this
  // label under any spelling, else MusicBrainz's. Either way `slugify(tracks.label)` lands
  // on a real `labels.slug`, which is what every label consumer — above all The Ear's
  // capture-priority ladder and its disabled-label VETO — silently depends on.
  let labelName = mbLabelName;

  if (mbLabelName && labelSlug(mbLabelName)) {
    const known = await canonicalLabelName(mbLabelName);

    if (known) {
      labelName = known;
    } else {
      // A label nobody has ruled on: it enters `undecided` (the `labels` DDL default) and
      // surfaces in the operator's attention queue. It is NOT crawled — the next crawl
      // seeds from it only if he enables it. The crawler proposes; the operator rules.
      await ensureLabel(mbLabelName);
      labelsDiscovered.push(mbLabelName);
    }
  }

  const coverUrl =
    release["cover-art-archive"]?.front === true
      ? `https://coverartarchive.org/release/${release.id}/front-500`
      : null;

  const candidates: TrackCandidate[] = [];
  const artistMbids = new Set<string>();

  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) {
      const recording = track.recording;
      const title = recording?.title ?? track.title;

      if (!recording?.id || !title) {
        continue;
      }

      const credits = recording["artist-credit"] ?? release["artist-credit"] ?? [];
      const artists = credits
        .map((credit) => credit.artist?.name ?? credit.name)
        .filter((name): name is string => Boolean(name));

      for (const credit of credits) {
        const id = credit.artist?.id;

        if (id && id !== VARIOUS_ARTISTS_MBID) {
          artistMbids.add(id);
        }
      }

      candidates.push({
        album: release.title ?? null,
        albumImageUrl: coverUrl,
        artists: artists.length > 0 ? artists : ["Unknown"],
        // `duration_ms` is NOT NULL on `tracks`. MusicBrainz genuinely does not always
        // know a recording's length, and 0 is the honest "unknown" — never a guess.
        durationMs: recording.length ?? track.length ?? 0,
        inMasterId,
        inReleaseId,
        isrc: recording.isrcs?.[0] ?? null,
        label: labelName ?? null,
        recordingId: recording.id,
        releaseDate: release.date ?? null,
        title,
      });
    }
  }

  const { skipped, written, writtenIds } = await writeCatalogueTracks(candidates);

  if (labelName) {
    await linkTracksToLabel(writtenIds, labelName);
  }

  // The other indexed edge these rows need, stamped in the same breath as `label_id` and for
  // the same reason: `/artist/<slug>` shows the rest of an artist's catalogue, and it can only
  // find these rows by an indexed seek on `track_artists`. Purely additive and best-effort —
  // it links a crawled track to an artist Fluncle has ALREADY certified, mints nothing, and
  // makes nothing here countable as a finding (lib/server/artists.ts). A track credited to
  // nobody he has found stays unlinked, exactly as it stays unlinked from an album he never
  // touched. The deploy-time reconcile is the backstop; this makes the edge live per tick.
  await linkTracksToArtistEntities(writtenIds);

  // The outward edge: the artists on this release, one hop further out. Past the limit
  // nothing is enqueued, which is what makes the walk terminate.
  let enqueued = 0;
  const artistHop = node.hop + 1;

  if (artistHop <= maxHop) {
    for (const mbid of artistMbids) {
      enqueued += await enqueue({
        externalId: mbid,
        hop: artistHop,
        kind: "artist",
        labelSlug: node.label_slug,
        parentId: node.id,
        source: "musicbrainz",
      });
    }
  }

  return {
    enqueued,
    labelsDiscovered,
    next: { cursor: 0, state: "done" },
    tracksFound: candidates.length,
    tracksSkipped: skipped,
    tracksWritten: written,
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * ONE bounded, polite, resumable crawl pass. Seeds from the operator's enabled labels,
 * expands `limit` frontier nodes breadth-first, writes the catalogue rows it finds, and
 * stops. Everything it learned is durable, so the next tick continues rather than
 * restarts — which is the whole point: this is a sweep, not a session.
 *
 * `dryRun` performs the SEED PLAN and no writes at all (no frontier rows, no tracks, no
 * labels): the honest answer to "what would this do", not a half-crawl.
 */
export async function crawlCatalogue({
  dryRun = false,
  limit = 10,
  maxHop = DEFAULT_MAX_HOP,
}: {
  dryRun?: boolean;
  limit?: number;
  maxHop?: number;
} = {}): Promise<CrawlPass> {
  const hopLimit = Math.max(0, Math.min(maxHop, MAX_HOP_CEILING));
  const pass: CrawlPass = {
    anchorsFilled: 0,
    dryRun,
    expanded: 0,
    failed: 0,
    frontierPending: 0,
    labelsDiscovered: [],
    maxHop: hopLimit,
    nodesEnqueued: 0,
    rateLimited: false,
    seeded: 0,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksWritten: 0,
  };

  if (dryRun) {
    const enabled = await listLabels("enabled");
    const status = await getCrawlStatus();

    return { ...pass, frontierPending: status.frontier.pending, seeded: enabled.length };
  }

  const seed = await seedFromEnabledLabels();
  pass.seeded = seed.minted;

  const nodes = await pickNodes(limit);

  for (const node of nodes) {
    try {
      const expansion =
        node.kind === "release"
          ? await expandRelease(node, hopLimit)
          : node.kind === "artist" || node.source === "musicbrainz"
            ? await expandBrowse(node, hopLimit)
            : await expandSeedLabel(node);

      await settle(node.id, expansion.next.state, {
        cursor: expansion.next.cursor,
        note: expansion.next.note,
      });

      pass.expanded += 1;
      pass.nodesEnqueued += expansion.enqueued;
      pass.tracksFound += expansion.tracksFound;
      pass.tracksWritten += expansion.tracksWritten;
      pass.tracksSkipped += expansion.tracksSkipped;
      pass.labelsDiscovered.push(...expansion.labelsDiscovered);
    } catch (error) {
      const throttled = error instanceof ThrottledError;

      await settle(node.id, "failed", {
        failures: node.failures + 1,
        note: throttled ? "musicbrainz rate-limited" : String(error).slice(0, 200),
      });
      pass.failed += 1;

      logEvent(throttled ? "warn" : "error", "crawl.node-failed", {
        error,
        kind: node.kind,
        node: node.id,
      });

      if (throttled) {
        // The circuit breaker. Re-firing into an active 503 wall just grinds the tick to
        // its timeout; the next tick resumes from a fresh rate window, from durable state.
        pass.rateLimited = true;
        break;
      }
    }
  }

  // The anchor fill runs LAST and on its own budget, so a Spotify 429 can never cost the
  // walk a node: by the time it runs, everything this pass discovered is already durable.
  const anchors = await fillSpotifyAnchors(ANCHOR_BUDGET);
  pass.anchorsFilled = anchors.filled;

  const status = await getCrawlStatus();
  pass.frontierPending = status.frontier.pending;

  return pass;
}

/**
 * The frontier at rest — what the walk holds, what it has drained, and what the operator
 * still has to rule on. The `/status`-shaped read behind `fluncle admin catalogue status`.
 */
export async function getCrawlStatus(): Promise<CrawlStatus> {
  const db = await getDb();
  const [states, kinds, catalogue, anchors, labels] = await Promise.all([
    db.execute("select state, count(*) as n from crawl_frontier group by state"),
    db.execute("select kind, count(*) as n from crawl_frontier group by kind"),
    // A CATALOGUE track is a `tracks` row with no `findings` row. That anti-join IS the
    // definition — counted in SQL, never by pulling the table into the isolate.
    db.execute(`select count(*) as n from tracks
                where not exists (select 1 from findings where findings.track_id = tracks.track_id)`),
    // The anchor queue, derived — the same predicate `fillSpotifyAnchors` drains, over the
    // same partial index.
    db.execute(`select count(*) as n from tracks
                where isrc is not null and spotify_uri is null
                  and not exists (select 1 from findings where findings.track_id = tracks.track_id)`),
    listLabels(),
  ]);

  const frontier = { done: 0, failed: 0, pending: 0, skipped: 0 };
  const frontierByKind = { artist: 0, label: 0, release: 0 };

  for (const row of typedRows<{ n: number; state: CrawlNodeState }>(states.rows)) {
    frontier[row.state] = Number(row.n);
  }

  for (const row of typedRows<{ kind: CrawlNodeKind; n: number }>(kinds.rows)) {
    frontierByKind[row.kind] = Number(row.n);
  }

  return {
    anchorsPending: Number(typedRows<{ n: number }>(anchors.rows)[0]?.n ?? 0),
    catalogueTracks: Number(typedRows<{ n: number }>(catalogue.rows)[0]?.n ?? 0),
    frontier,
    frontierByKind,
    labelsUndecided: labels.filter((label) => label.seedState === "undecided").length,
    seedLabels: labels
      .filter((label) => label.seedState === "enabled")
      .map((label) => label.name)
      .sort(),
  };
}
