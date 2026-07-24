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
// ── THE BOUNDARY GATE: enabled-label STORAGE + graph-distance DISCOVERY ──────────
// There is NO genre inference here — no MusicBrainz tag, no Discogs style, no BPM band.
// The operator already drew the boundary when he ruled on the labels (`labels.seed_state`,
// docs/label-entity.md). Two things follow from it, and they are DISTINCT:
//
//   STORAGE — a release's tracks are written ONLY when the label that pressed it is one the
//     operator ENABLED (`isEnabledLabel`, checked at the write chokepoint in `expandRelease`).
//     A release on a non-enabled label is walked but stores nothing — no tracks, no album, no edges.
//
//   DISCOVERY — the walk still runs to graph distance so it can FIND the next labels to rule on:
//       hop 0 — a release on a label whose `seed_state` is `enabled`
//       hop 1 — an artist who appears on such a release
//       hop 2 — a release that artist ALSO appears on
//     …and STOP at `maxHop` (default 2). A node past the limit is never enqueued, so the walk
//     terminates by construction rather than by a watchdog. Hop distance bounds the DISCOVERY,
//     never the STORAGE: a hop-2 release on an enabled label IS stored; a hop-0 seed release is
//     stored because its seed label is enabled, not because it sits at hop 0.
//
// A label the walk DISCOVERS that nobody has ruled on enters as `undecided` (the
// `labels` DDL default) and surfaces in the operator's attention queue. It is NOT
// crawled — and, until enabled, its releases store nothing. A subsequent crawl seeds from it
// (and stores it) only once the operator enables it. That is the self-widening-but-operator-
// ratified loop: the crawler proposes, the operator rules.
//
// ── WHY MUSICBRAINZ CARRIES THE WALK ───────────────────────────────────────────
// MusicBrainz is the only one of the three sources that is RECORDING-centric, which is
// what a track-level catalogue needs: label → releases → recordings (with ISRCs) →
// artist credits → their other releases is a clean, complete, paginated graph, CC0, and
// free of a token. Discogs is RELEASE-centric — it has no recording entity and no ISRCs,
// so it cannot supply a stable track identity and cannot be the spine. We still reach
// the Discogs release graph, but through the join that already exists: MusicBrainz's
// CURATED `url-rels` relation, which hands us the Discogs release/master id for free, in
// the same request that brought the tracks, with zero Discogs API calls. Spotify no longer
// enters the crawl at all: the `spotify_uri`/`spotify_url` anchor is optional — a track with
// no Spotify presence is a perfectly good row — and filling it moved ENTIRELY off this Worker
// path onto the box's Apify-driven anchor sweep (docs/agents/hermes/scripts/anchor-sweep.*),
// which POSTs verified candidates to the agent-tier `anchor_track` op (lib/server/anchor.ts).
// The first pilot put a per-ISRC Spotify lookup in the write path and Spotify 429'd; the
// second ran it as a bounded in-Worker step against the official dev-mode Spotify app, and at
// catalogue scale THAT starved under sustained 429s too. So the crawl is now MusicBrainz-only,
// its documented mandate, and the anchor's worklist is DERIVED (`spotify_uri is null`) — nothing
// is lost when the box sweep is paused. See docs/catalogue-crawler.md § the anchor.
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

import { ensureAlbum } from "./albums";
import { linkTracksToArtistEntities, stampRemixerRoles } from "./artists";
import { existingAlbumTitleFolds, foldTrackTitle } from "./catalogue-dedupe";
import { getDb, typedRows } from "./db";
import { parseDiscogsUrl } from "./discogs";
import { setLabelMbLabelId } from "./label-images";
import { ensureLabel, labelFold, labelSlug, listLabels } from "./labels";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";

// ── Policy constants ─────────────────────────────────────────────────────────

/** The ratified default: label → release → artist → release, then stop. */
export const DEFAULT_MAX_HOP = 2;

/** A hard ceiling on the configurable limit — past 3 the walk is the whole of music. */
export const MAX_HOP_CEILING = 3;

/** MusicBrainz's browse page size ceiling. One page = one request. */
const BROWSE_PAGE_SIZE = 100;

/**
 * THE CURSOR, SIGNED — one integer carries a browse node's walk DIRECTION and its offset, so
 * the tail-first re-arm needs no schema column (the frontier stays exactly as wide as it was):
 *
 *   `cursor >= 0`  — a FORWARD walk (a cold seed's initial drain). `offset = cursor`. The whole
 *                    list, head to tail, one page a tick. Unchanged from before this existed.
 *   `cursor === REARM_TAIL` (`-1`) — a re-armed node whose tail has not been located yet. Its
 *                    first backward tick probes the CURRENT `release-count`, then reads the tail.
 *   `cursor <= -2` — a backward DESCENT page. `offset = descendOffset(cursor)` (a page walking
 *                    from the tail toward the head, stopping at the first all-known page).
 *
 * The three bands are disjoint by construction, so `expandBrowse` reads the mode straight off
 * the sign with no ambiguity, and `descendCursor(0) = -2` never collides with `REARM_TAIL`.
 */
const REARM_TAIL = -1;

/** A backward-descent offset → its (negative) cursor. `0 → -2`, `100 → -102`. */
function descendCursor(offset: number): number {
  return -(offset + 2);
}

/** A descent cursor → its browse offset — the inverse of {@link descendCursor}. */
function descendOffset(cursor: number): number {
  return -cursor - 2;
}

/** Consecutive failures after which a node is abandoned (stays `failed`, never picked). */
const MAX_FAILURES = 5;

/**
 * THE SEED RE-ARM. An enabled seed label is a SUBSCRIPTION, not a one-shot walk: once its
 * MusicBrainz browse node finishes paginating it goes `done`, and without this it would stay
 * done forever — so a release the label pressed AFTER that first drain (a Friday drop) would
 * never surface. `REARM_AFTER_DAYS` is how stale a `done` seed-label node may get before the
 * re-arm flips it back to `pending` to re-check its list. Now that a re-arm reads only the
 * TAIL of the list (`expandRearmedBrowse`, ~1 browse page) instead of re-walking the whole
 * thing forward, the cadence is DAILY — ~1 page per re-armed label costs ~99 nodes/day of the
 * ~1,400-node budget — so a Friday drop lands by Saturday, bounded only by MusicBrainz's own
 * ingest lag (the sweep ticks every ~10 min).
 */
export const REARM_AFTER_DAYS = 1;

/**
 * How many stale seed-label nodes one pass re-arms, oldest-done-first. Bounded so a mass re-arm
 * — every enabled label crossing the threshold in the same window (88 of them, one deploy-day
 * cohort) — spreads over passes instead of flooding the frontier head and starving the deep
 * walk it SHARES the 1 req/s MusicBrainz budget with. A row this pass skips comes round next.
 */
export const REARM_BATCH = 10;

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
  /**
   * Stale seed-label browse nodes re-armed this pass (bounded by `REARM_BATCH`) — an enabled
   * label re-paginates on the re-arm threshold so its later releases surface. See `rearmSeedLabels`.
   */
  seedsRearmed: number;
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
  // MusicBrainz's album abstraction over a release's pressings, returned as a singular object
  // (a release belongs to exactly one) when `release-groups` is in `inc`. Its MBID is the
  // catalogue's stable album fold key. Verified against the live web service.
  "release-group"?: { id?: string };
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
 *
 * The freshness tap (label-releases.ts) is the sibling minter: its rows carry `sp_<spotify-track-id>`,
 * the same namespaced-id convention off the identity Spotify gives it. The two converge on ONE row
 * per recording via the shared dedupe contract (ISRC + same-album title fold — catalogue-dedupe.ts).
 */
export function catalogueTrackId(recordingMbid: string): string {
  return `mb_${recordingMbid}`;
}

// The aggressive label fold ("Medschool" ⇄ "Med School", "Pilot." ⇄ "Pilot") is the shared
// `labelFold` (re-exported from ./labels), so the crawler's label dedup and the Apple
// recordLabel corroboration agree by construction. When two MB labels fold the same (there
// are two "Hospital Records", London and US), the first — MusicBrainz returns them
// score-ordered — wins, so the choice is deterministic rather than arbitrary.
const fold = labelFold;

// ── Frontier persistence ─────────────────────────────────────────────────────

/**
 * Enqueue a node, unless the frontier already holds it. `on conflict do nothing` is the
 * whole cycle guard: an artist reached from two different releases is ONE node.
 * Returns 1 when a node was actually minted, 0 when it collided — the NEWNESS signal the
 * tail-first re-arm early-stops on (a browse page that mints 0 new nodes is already walked).
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
 * The pass's pick: the next `limit` nodes to expand — breadth-first and deterministic
 * (`hop, demand_rank, created_at, id`) WITHIN each half of a kind-aware split. `demand_rank`
 * (docs/catalogue-crawler.md § Demand) sits AFTER `hop`, so a demanded entity's subtree is
 * expanded before its undemanded siblings AT THE SAME HOP — never ahead of a nearer hop, so
 * breadth-first is preserved. It takes `pending`
 * nodes plus `failed` ones whose exponential backoff has elapsed and which have not
 * yet been abandoned — so a transient 503 is retried by a later tick instead of
 * silently pruning a subtree.
 *
 * THE SPLIT (the 2026-07-16 starvation fix). A pure `hop asc` drain starves the
 * track-bearing kind: a wave of hop-1 ARTIST nodes (2,015 of them, measured live)
 * sorts ahead of every hop-2 RELEASE node, and each artist expansion enqueues ~9
 * more releases — so the frontier grew ~12k nodes in a day while `tracksWritten`
 * sat at ZERO for eight hours. The crawler's whole job is metadata acquisition;
 * only a RELEASE node writes tracks. So every pick now GUARANTEES releases half
 * the batch (rounded up) when any are pending, and discovery kinds (label/artist)
 * fill the rest — acquisition and discovery move together, deterministically, and
 * neither can starve the other (releases still drain a widening artist wave's
 * output; artists still drain even under a release glut).
 */
async function pickNodes(limit: number): Promise<FrontierRow[]> {
  const db = await getDb();
  const now = Date.now();
  // One cutoff per failure count, computed here rather than in SQL: SQLite has no clean
  // exponential, and an ISO string comparison is exact.
  const cutoff = (failures: number): string =>
    new Date(now - Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS)).toISOString();

  const eligible = `(state = 'pending'
             or (state = 'failed'
                 and failures < ?
                 and attempted_at <= (case failures
                                        when 1 then ?
                                        when 2 then ?
                                        when 3 then ?
                                        else ? end)))`;
  const releaseShare = Math.ceil(limit / 2);
  const cutoffs = [MAX_FAILURES, cutoff(1), cutoff(2), cutoff(3), cutoff(4)];

  const releases = await db.execute({
    args: [...cutoffs, releaseShare],
    sql: `select id, kind, source, external_id, hop, cursor, failures, label_slug
          from crawl_frontier
          where kind = 'release' and ${eligible}
          order by hop asc, demand_rank asc, created_at asc, id asc
          limit ?`,
  });
  const releaseRows = typedRows<FrontierRow>(releases.rows);
  const remainder = limit - releaseRows.length;

  if (remainder <= 0) {
    return releaseRows;
  }

  // The rest of the batch: any kind, oldest-lowest-hop first, excluding the release
  // ids already picked (releases may win these slots too when discovery is drained).
  const placeholders = releaseRows.map(() => "?").join(", ");
  const rest = await db.execute({
    args: [...cutoffs, ...releaseRows.map((row) => row.id), remainder],
    sql: `select id, kind, source, external_id, hop, cursor, failures, label_slug
          from crawl_frontier
          where ${eligible}
            ${releaseRows.length > 0 ? `and id not in (${placeholders})` : ""}
          order by hop asc, demand_rank asc, created_at asc, id asc
          limit ?`,
  });

  return [...releaseRows, ...typedRows<FrontierRow>(rest.rows)];
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

/**
 * THE SEED RE-ARM — turn an enabled seed label back into a live subscription.
 *
 * A `done` node is otherwise TERMINAL: `pickNodes` only ever picks `pending` (or backed-off
 * `failed`) nodes, so a seed label whose MusicBrainz browse finished paginating goes `done`
 * and stays there. That is correct for the deep walk (a re-crawl of the same graph writes
 * zero rows), but it means a label's LATER releases — a Friday drop on a label the operator
 * enabled — are never seen. An enabled label should be a subscription, not a one-shot walk.
 *
 * WHICH node. The seed's `fluncle:label` node only resolves the name→MBID once; the node that
 * actually browses `/release?label=<mbid>` and paginates is the MusicBrainz label ENTITY node
 * (`source = 'musicbrainz'`, `kind = 'label'`). Re-arming THAT — `state → 'pending'`, `cursor
 * → REARM_TAIL` — makes `expandBrowse` re-read the label's release list TAIL-FIRST. Re-arming
 * the `fluncle` seed node would be pure waste: its expansion just re-enqueues the (already-present,
 * still-`done`) MBID node as an `on conflict do nothing` no-op. So this targets `source =
 * 'musicbrainz'` precisely.
 *
 * WHY it stays cheap — TAIL-FIRST, not a full re-walk. MusicBrainz's release browse has NO date
 * sort: its order is append-ish, so a label's NEWEST releases sit at the END of the list (page 1
 * is the oldest pressing, the last page the newest). So the re-arm does NOT re-walk the whole
 * list from the head — `expandRearmedBrowse` starts at the LAST page and pages backward, stopping
 * at the first page that adds nothing new (every release node already present ⇒ the territory
 * below is already walked). In steady state that is ONE browse page (probe + tail) per label with
 * no drop, so the DAILY cadence (`REARM_AFTER_DAYS = 1`) costs ~99 nodes/day of the ~1,400 budget.
 * A genuinely new release still mints a `pending` node and gets walked, and the two-layer
 * idempotence in `writeCatalogueTracks` folds any already-held track (a re-press) to a cheap skip.
 *
 * THE GUARDS, all load-bearing:
 *   - `seed_state = 'enabled'` (joined on the node's `label_slug`) — a subscription is only for
 *     labels the operator still seeds from. A `disabled`/`undecided` label's node never re-arms:
 *     re-arm is crawl SCOPE, the same rule seeding obeys.
 *   - `kind = 'label'` — never an artist or release node (those are re-reached BY the browse).
 *   - `state = 'done'` — a `failed` node is owned by its own exponential backoff; never disturb it.
 *   - `done_at < now − REARM_AFTER_DAYS` — a freshly-drained label is not re-walked immediately.
 *
 * BOUNDED. At most `REARM_BATCH` per pass, oldest-done-first, so a cohort of labels all crossing
 * the threshold together spreads across passes rather than flooding the frontier head. Returns
 * the count and logs it, so a re-arm wave is visible rather than silent.
 */
async function rearmSeedLabels(): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - REARM_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // One bounded UPDATE. The subquery picks the batch (oldest-done-first, capped) — SQLite forbids
  // ORDER BY/LIMIT on the UPDATE itself but allows it in the row-selecting subquery. `label_slug`
  // is joined to the `enabled` seed set (a bounded, tens-of-rows table), never pulled into the isolate.
  // `cursor → REARM_TAIL` arms the TAIL-FIRST re-read (`expandRearmedBrowse`), not a full forward re-walk.
  const result = await db.execute({
    args: [REARM_TAIL, now, cutoff, REARM_BATCH],
    sql: `update crawl_frontier
          set state = 'pending', cursor = ?, updated_at = ?
          where id in (
            select id from crawl_frontier
            where kind = 'label'
              and source = 'musicbrainz'
              and state = 'done'
              and done_at is not null
              and done_at < ?
              and label_slug in (select slug from labels where seed_state = 'enabled')
            order by done_at asc, id asc
            limit ?
          )`,
  });

  const rearmed = result.rowsAffected;

  if (rearmed > 0) {
    logEvent("info", "crawl.seeds-rearmed", { count: rearmed });
  }

  return rearmed;
}

// ── The writes ───────────────────────────────────────────────────────────────

/**
 * Write a release's tracks into `tracks` as CATALOGUE rows — and nowhere near `findings`.
 *
 * IDEMPOTENCE, in THREE layers, because two were not enough once the freshness tap arrived:
 *   1. A bounded pre-read over the candidates' ISRCs + minted ids (`tracks_isrc_idx`).
 *      An ISRC is the recording's real identity, so a track Fluncle already CERTIFIED —
 *      whose `track_id` is a Spotify id, not `mb_…` — is recognised and skipped. Without
 *      this the crawler would happily mint a second, uncertified row for a finding.
 *   2. THE SAME-ALBUM TITLE-FOLD CONVERGENCE (`releaseAlbumId`). A freshness-tapped row
 *      (`sp_<id>`, label-releases.ts) can arrive with a MISSING or DIVERGENT ISRC — Spotify
 *      and MusicBrainz occasionally disagree on a recording's ISRC — so layer 1 would miss
 *      it and this later MB walk of the same release would mint an `mb_` twin. This closes
 *      that: a candidate whose title EXACT-folds to an existing row on the SAME album row
 *      (the release's `album_id`, resolved before the write) is recognised as that row and
 *      skipped. Deliberately TIGHT — exact fold, one album — so a VIP/remix (a different
 *      title, "Foo VIP" ≠ "Foo") is never merged. See catalogue-dedupe.ts.
 *   3. `on conflict (track_id) do nothing` on the insert, which closes the race the
 *      pre-reads cannot (two ticks, same recording) at the primary key.
 *
 * `capture_status` and every other queue column are simply never named: the DDL defaults
 * land, the row is nobody's work item, and no agent sweep can reach it (the enrichment,
 * note, observe and video queues all live on `findings`, which this row does not have).
 */
async function writeCatalogueTracks(
  candidates: TrackCandidate[],
  releaseAlbumId: null | string,
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

  // Layer 2: the same-album title-fold convergence index (the Apple-twin guard).
  const albumTitleFolds = await existingAlbumTitleFolds(releaseAlbumId);

  let written = 0;
  let skipped = 0;
  const writtenIds: string[] = [];

  for (const candidate of candidates) {
    const trackId = catalogueTrackId(candidate.recordingId);
    const titleFold = foldTrackTitle(candidate.title);

    if (
      heldIds.has(trackId) ||
      (candidate.isrc && heldIsrcs.has(candidate.isrc)) ||
      (releaseAlbumId && titleFold && albumTitleFolds.has(titleFold))
    ) {
      skipped += 1;
      continue;
    }

    // NO Spotify call here. The `spotify_uri`/`spotify_url` anchor is filled off this Worker path
    // entirely — the box's Apify anchor sweep → the agent-tier `anchor_track` op (anchor.ts). Its
    // worklist is derived (`spotify_uri is null`), so a row landing here with no anchor is simply
    // picked up on a later anchor tick. See docs/catalogue-crawler.md § the anchor.
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
        // The MusicBrainz recording MBID — the canonical KG join key (docs/catalogue-crawler.md §
        // the MusicBrainz identity layer). It is already in the PK (`track_id` is `mb_<mbid>`), but
        // stamping it here too means a crawled row is graph-joinable off the bat instead of waiting
        // on the prefix-strip backfill, and the `/log` MusicRecording emits it the moment such a row
        // is certified in place. The one-off `recording-mbids.ts` strip only catches history up.
        candidate.recordingId,
      ],
      sql: `insert into tracks
              (track_id, title, artists_json, duration_ms, album, album_image_url, isrc,
               label, release_date, in_release_id, in_master_id, mb_recording_id)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (track_id) do nothing`,
    });

    if (result.rowsAffected > 0) {
      written += 1;
      writtenIds.push(trackId);
      heldIds.add(trackId);

      if (candidate.isrc) {
        heldIsrcs.add(candidate.isrc);
      }

      if (titleFold) {
        // Guard two candidates on one release that fold to the same title within this batch.
        albumTitleFolds.set(titleFold, trackId);
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
 * The deploy-time `linkTracksToLabels` backfill self-heals any writer that does not know
 * the column, this crawler included. But a crawl ticks every ten minutes and a deploy
 * does not, so a crawled row would sit off its label's page until the next one. This closes
 * that window; the backfill stays the backstop.
 *
 * It resolves the label on the MBID FIRST (`where mb_label_id = ?`), then falls back to
 * `slugify(label)`. The MBID fold is why two spellings that slugify apart ("Med School" ⇄
 * "Medschool") point at the SAME label row; the slug fallback is why the crawler writes the
 * ARCHIVE's spelling of a label it already knows (`canonicalLabelName`) rather than
 * MusicBrainz's, so even a label with no MBID lands on a real `labels.slug` rather than
 * pointing at nothing. Purely resolve-and-stamp — it never mints (the discovered label was
 * already minted by `ensureLabel` above, and a known label already exists).
 *
 * Its album twin is `linkTracksToAlbumId` below: the album edge is written INLINE at crawl
 * time now, folded on the release-group MBID, not deferred to a deploy backfill.
 */
async function linkTracksToLabel(
  trackIds: string[],
  labelName: string,
  mbLabelId: null | string,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  const db = await getDb();
  const mbid = mbLabelId?.trim() ? mbLabelId.trim() : null;

  // mbid-first: the row `ensureLabel` just folded on this MBID, whatever its slug. Falls back
  // to the archive-spelling slug for a label with no MBID (the common pre-catalogue case).
  let labelId: string | undefined;

  if (mbid) {
    const byMbid = await db.execute({
      args: [mbid],
      sql: `select id from labels where mb_label_id = ? limit 1`,
    });
    labelId = typedRows<{ id: string }>(byMbid.rows)[0]?.id;
  }

  if (!labelId) {
    const slug = labelSlug(labelName);

    if (!slug) {
      return;
    }

    const found = await db.execute({
      args: [slug],
      sql: `select id from labels where slug = ? limit 1`,
    });
    labelId = typedRows<{ id: string }>(found.rows)[0]?.id;
  }

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
 * Stamp `tracks.album_id` on the rows this release just wrote — the album twin of
 * `linkTracksToLabel`, and the indexed edge the public `/album/<slug>` page reads by
 * (docs/album-entity.md). ONE batched UPDATE per RELEASE, never per track, mirroring the label
 * pattern above.
 *
 * `albumId` is resolved ONCE by the caller (`ensureAlbum(release.title, releaseGroupMbid)`) BEFORE
 * the write, because the same id is the same-album title-fold dedupe key `writeCatalogueTracks`
 * needs — resolving it in two places would risk two ids. The fold key is the release-group MBID
 * (every pressing of one record → the SAME album row; an album a finding minted first is adopted
 * onto the mbid rather than duplicated), with `ensureAlbum`'s slug fallback for a release MB has no
 * release group for. A null id (a blank title, no release group) links nothing.
 */
async function linkTracksToAlbumId(trackIds: string[], albumId: null | string): Promise<void> {
  if (trackIds.length === 0 || !albumId) {
    return;
  }

  const db = await getDb();

  await db.execute({
    args: [albumId, ...trackIds],
    sql: `update tracks set album_id = ?
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
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

/** The `{ id }` releases off a browse response — the ill-formed ones dropped. */
function browseReleases(browse: MbReleaseBrowse | null): { id: string }[] {
  return (browse?.releases ?? []).filter(
    (release): release is { id: string } => typeof release.id === "string",
  );
}

/**
 * Enqueue one browse page's releases as `release` nodes and return how many were GENUINELY NEW
 * (an `on conflict do nothing` no-op returns 0). That new-count is load-bearing twice over: it is
 * the walk's outward edge (`enqueued`), and it is the tail-first re-arm's EARLY-STOP signal — a
 * page that mints nothing new means every release below it is already walked.
 */
async function enqueueReleaseNodes(
  node: FrontierRow,
  releases: { id: string }[],
  childHop: number,
): Promise<number> {
  let newlyEnqueued = 0;

  for (const release of releases) {
    newlyEnqueued += await enqueue({
      externalId: release.id,
      hop: childHop,
      kind: "release",
      labelSlug: node.label_slug,
      parentId: node.id,
      source: "musicbrainz",
    });
  }

  return newlyEnqueued;
}

/**
 * A MusicBrainz label (or artist) node → one page of its releases, as `release` nodes.
 *
 * ONE request per tick per node (the tail-first re-arm's first tick is the one exception — a
 * count probe plus the tail read). A node stays `pending` with its browse cursor advanced, so a
 * 900-release label drains across ticks instead of blowing a single one — the resumability that
 * matters most in practice, because the biggest seed label is also the one most likely to be
 * interrupted.
 *
 * TWO WALKS, read straight off the signed cursor (see `REARM_TAIL` / `descendCursor`):
 *   - `cursor >= 0` — a COLD node's FORWARD drain (`expandForwardBrowse`): the whole list, head
 *     to tail, one page a tick. The initial walk must see everything.
 *   - `cursor < 0`  — a RE-ARMED node's TAIL-FIRST re-read (`expandRearmedBrowse`): MusicBrainz's
 *     browse has no date sort and appends new pressings at the END, so the fresh drop lives at the
 *     tail. Page backward from the last page, stop at the first all-known page.
 */
async function expandBrowse(node: FrontierRow, maxHop: number): Promise<Expansion> {
  const childHop = node.kind === "label" ? 0 : node.hop + 1;

  if (childHop > maxHop) {
    return { ...EMPTY, next: { cursor: 0, note: `hop limit ${maxHop}`, state: "done" } };
  }

  const key = node.kind === "label" ? "label" : "artist";

  return node.cursor < 0
    ? expandRearmedBrowse(node, key, childHop)
    : expandForwardBrowse(node, key, childHop);
}

/** A COLD browse node's forward drain — the whole release list, head to tail, one page a tick. */
async function expandForwardBrowse(
  node: FrontierRow,
  key: string,
  childHop: number,
): Promise<Expansion> {
  const browse = await mb<MbReleaseBrowse>(
    `/release?${key}=${node.external_id}&limit=${BROWSE_PAGE_SIZE}&offset=${node.cursor}`,
  );
  const releases = browseReleases(browse);
  const enqueued = await enqueueReleaseNodes(node, releases, childHop);

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
 * A RE-ARMED browse node's TAIL-FIRST re-read. Because MusicBrainz appends new pressings at the
 * end of an unsorted browse list, a re-arm only needs to look at the TAIL — it starts at the last
 * page and pages backward, stopping the moment a page adds nothing new.
 *
 * FIRST tick (`cursor === REARM_TAIL`): the tail's offset depends on the CURRENT count, which the
 * node does not store, so it is probed (`limit=1`) and the tail read in the SAME tick — the count
 * that aims the tail is then at most one shared-client hop stale, which closes the race below.
 *
 * THE GROW RACE. If the count GREW between the probe and the tail read, `offset` aimed at the OLD
 * tail and the page missed the newest rows `[staleTotal, total)`. Re-aim the descent at the FRESH
 * tail and do NOT early-stop — the true newest have not been seen. This can only happen on the
 * first (tail-locating) page; a normal descent page is deliberately below the tail, so it is never
 * mistaken for an under-aim. Growth AFTER the tail read is the NEXT daily re-arm's job.
 *
 * EARLY STOP: a page that mints nothing new (`newlyEnqueued === 0`) means everything below is
 * already walked; and `offset === 0` is the floor (the whole list re-swept). Either ends the walk.
 * The one-page label (< `BROWSE_PAGE_SIZE` releases) is the degenerate tail = page 0 case, handled
 * by the same two conditions. Every new release still mints a `pending` node the deep walk drains.
 */
async function expandRearmedBrowse(
  node: FrontierRow,
  key: string,
  childHop: number,
): Promise<Expansion> {
  const browse = (offset: number, limit: number): Promise<MbReleaseBrowse | null> =>
    mb<MbReleaseBrowse>(`/release?${key}=${node.external_id}&limit=${limit}&offset=${offset}`);

  let offset: number;
  let staleTotal: null | number = null;

  if (node.cursor === REARM_TAIL) {
    const probe = await browse(0, 1);
    staleTotal = probe?.["release-count"] ?? 0;

    if (staleTotal <= 0) {
      // MusicBrainz now lists nothing for this label — nothing to re-walk. Done, cheaply.
      return { ...EMPTY, next: { cursor: 0, state: "done" } };
    }

    offset = Math.max(0, staleTotal - BROWSE_PAGE_SIZE);
  } else {
    offset = descendOffset(node.cursor);
  }

  const page = await browse(offset, BROWSE_PAGE_SIZE);
  const releases = browseReleases(page);
  const total = page?.["release-count"] ?? offset + releases.length;
  const enqueued = await enqueueReleaseNodes(node, releases, childHop);

  if (staleTotal !== null && total > staleTotal) {
    // The count grew in the probe→tail window: re-aim at the fresh tail, cover the miss next tick.
    return {
      ...EMPTY,
      enqueued,
      next: { cursor: descendCursor(Math.max(0, total - BROWSE_PAGE_SIZE)), state: "pending" },
    };
  }

  if (enqueued === 0 || offset === 0) {
    return { ...EMPTY, enqueued, next: { cursor: 0, state: "done" } };
  }

  // Descend one page toward the head. Clamp at 0 so a non-page-aligned tail offset (`total` is
  // rarely a multiple of the page size) lands on the head remainder rather than a negative offset.
  return {
    ...EMPTY,
    enqueued,
    next: { cursor: descendCursor(Math.max(0, offset - BROWSE_PAGE_SIZE)), state: "pending" },
  };
}

// ── THE STORAGE GATE: enabled-label-only ───────────────────────────────────────
// The whitelist (`labels.seed_state = 'enabled'`) now gates STORAGE, not only seeding. A
// release's tracks are WRITTEN only when the label that pressed it is one the operator
// ENABLED; the 2-hop walk is a label-DISCOVERY mechanism (it surfaces unruled labels into
// the ruling queue), never a licence to store. So a hop-2 release on a reggae/jazz/major
// label is still walked for the labels it reveals, then its tracks are dropped on the floor.
//
// Read ONCE per crawl tick (tens of labels), never per-release in the hot loop: memoized in
// `enabledLabelFolds`, which `crawlCatalogue` clears at the top of every pass — so a mid-crawl
// ruling is honoured on the NEXT tick. Matched by the same aggressive `fold` the rest of the
// file uses ("Medschool" ⇄ "Med School"), against the ARCHIVE spelling already resolved into
// `labelName`, so the gate agrees with `linkTracksToLabel` and the seed walk by construction.
let enabledLabelFolds: null | Set<string> = null;

async function isEnabledLabel(labelName: null | string | undefined): Promise<boolean> {
  const key = labelName ? fold(labelName) : "";

  if (!key) {
    return false;
  }

  if (!enabledLabelFolds) {
    const enabled = await listLabels("enabled");
    enabledLabelFolds = new Set(enabled.map((label) => fold(label.name)).filter(Boolean));
  }

  return enabledLabelFolds.has(key);
}

/**
 * A release node → THE WRITE. One request brings the whole release: its tracks, their
 * recordings (with MBIDs and ISRCs), the artist credits, the label, and — for free, in
 * the same payload — MusicBrainz's curated Discogs `url-rels` relation, which is how the
 * catalogue reaches the Discogs release graph without a single Discogs API call.
 *
 * It also mints a `labels` row for the release's label. THAT is the widening loop: a
 * label nobody has ruled on enters `undecided` and lands in the operator's attention
 * queue. It does not get crawled until he enables it — and, since the STORAGE GATE, its
 * tracks are not stored until then either; the walk only ever DISCOVERS it. When the label
 * IS enabled it mints + links the `albums` row for the release, folded on the release-group
 * MBID (`inc=release-groups`) — the album edge is written inline here, not deferred.
 */
async function expandRelease(node: FrontierRow, maxHop: number): Promise<Expansion> {
  const release = await mb<MbReleaseDetail>(
    `/release/${node.external_id}?inc=recordings+artist-credits+isrcs+labels+release-groups+url-rels`,
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

  // The label edge, taken from the SAME `label-info` entry so the name and the MBID belong to
  // one label. The MBID (`label.id`) is MusicBrainz's stable label identity — the discovered
  // label's fold key, the twin of the release-group MBID the album edge folds on.
  const mbLabel = (release["label-info"] ?? []).find((info) => info.label?.name)?.label;
  const mbLabelName = mbLabel?.name;
  const mbLabelId = mbLabel?.id ?? null;
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
      // Minted (or folded) on the MBID so two spellings that slugify apart collapse to one row.
      await ensureLabel(mbLabelName, mbLabelId);
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

  // ── THE STORAGE GATE ──────────────────────────────────────────────────────────
  // Store this release's tracks ONLY when its label is one the operator ENABLED. A hop-2
  // release on a non-enabled label was still walked above (its label was DISCOVERED into the
  // ruling queue via `ensureLabel`), but nothing is stored for it — no tracks, no album, no
  // edges. The artist-hop walk BELOW still runs regardless, because the walk is how the crawler
  // reaches the next labels to rule on; it is naturally hop-bounded and terminates by construction.
  let skipped = candidates.length;
  let written = 0;

  if (await isEnabledLabel(labelName)) {
    // The album row, resolved ONCE up front (folded on the release-group MBID, slug fallback). It is
    // the same-album title-fold dedupe key `writeCatalogueTracks` reads (the Apple-twin guard) AND
    // the `album_id` edge stamped below — one resolve, so the two can never disagree. Resolved inside
    // the gate: a non-enabled release stores no album either, so no childless `albums` row is minted.
    const albumId =
      (await ensureAlbum(release.title ?? null, release["release-group"]?.id ?? null)) ?? null;

    const result = await writeCatalogueTracks(candidates, albumId);
    skipped = result.skipped;
    written = result.written;
    const { writtenIds } = result;

    if (labelName) {
      await linkTracksToLabel(writtenIds, labelName, mbLabelId);
    }

    // The album edge, stamped INLINE — every pressing of a record resolves to one album row.
    // Purely additive; a crawled album is minted here now, no deploy backfill.
    await linkTracksToAlbumId(writtenIds, albumId);

    // The other indexed edge these rows need, stamped in the same breath as `label_id` and for
    // the same reason: `/artist/<slug>` shows the rest of an artist's catalogue, and it can only
    // find these rows by an indexed seek on `track_artists`. This is the NAME-FOLD half — the
    // FALLBACK for a track with no Spotify presence: it links a crawled track to an artist Fluncle
    // has ALREADY certified (by name), mints nothing, and makes nothing here countable as a finding
    // (lib/server/artists.ts). The stable-id half runs later, at the Spotify-anchor step
    // (`connectAnchorArtists` in anchor.ts, driven by the box's anchor sweep), which MINTS the entity
    // by `spotify_artist_id` for a track that gains a Spotify presence. A track credited to nobody he
    // has found stays unlinked until its
    // entity exists; the one-off `backfill-artist-links.ts` reconciles that (no longer a deploy step).
    await linkTracksToArtistEntities(writtenIds);

    // Stamp any remixer credit these titles name (RFC label-lineage-remixer, U2), now the
    // `track_artists` edges exist. A crawled remix by an ALREADY-CERTIFIED remixer (the only kind
    // `linkTracksToArtistEntities` links) gets its `role='remixer'` stamp; an uncertified remixer
    // has no linked row, so nothing is stamped — the same exact-match-only rail.
    await stampRemixerRoles(writtenIds);
  }

  // The outward edge: the artists on this release, one hop further out. Past the limit
  // nothing is enqueued, which is what makes the walk terminate. This is the DISCOVERY leg —
  // it runs whether or not the release was stored, so a non-enabled release still leads the
  // walk on to the labels it can reveal.
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
  // Reset the storage gate's memo so this tick reads the enabled-label set fresh — a ruling the
  // operator made since the last tick takes effect now, and stale enablement never leaks across ticks.
  enabledLabelFolds = null;

  const hopLimit = Math.max(0, Math.min(maxHop, MAX_HOP_CEILING));
  const pass: CrawlPass = {
    dryRun,
    expanded: 0,
    failed: 0,
    frontierPending: 0,
    labelsDiscovered: [],
    maxHop: hopLimit,
    nodesEnqueued: 0,
    rateLimited: false,
    seeded: 0,
    seedsRearmed: 0,
    tracksFound: 0,
    tracksSkipped: 0,
    tracksWritten: 0,
  };

  if (dryRun) {
    const enabled = await listLabels("enabled");

    // Only the pending frontier depth is reported, so take it as a single index-served count — never
    // the full `getCrawlStatus` (its catalogue anti-join + by-kind group-by are scans no caller here
    // reads, docs/db-scale-backlog Wave 1 #3).
    return { ...pass, frontierPending: await countFrontierPending(), seeded: enabled.length };
  }

  const seed = await seedFromEnabledLabels();
  pass.seeded = seed.minted;

  // Re-arm stale enabled seed labels BEFORE the pick, so a re-armed browse node can be expanded
  // in this very pass (the subscription rides every tick — the cron needs no change). Bounded, so
  // this never floods the frontier head ahead of the deep walk they share the rate budget with.
  pass.seedsRearmed = await rearmSeedLabels();

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
        // Preserve the browse cursor across a transient failure so the retry RESUMES where it was —
        // a paginated forward drain keeps its offset, and a re-armed node keeps its tail-first state
        // (`REARM_TAIL`/descent) instead of collapsing to `0`, which would restart it as a full walk.
        cursor: node.cursor,
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

  // The crawl is MusicBrainz-only now. Filling the Spotify anchor moved ENTIRELY off this Worker
  // path onto the box's Apify anchor sweep → the agent-tier `anchor_track` op (lib/server/anchor.ts,
  // docs/catalogue-crawler.md § the anchor); its worklist is derived (`spotify_uri is null`), so a
  // row the crawl just wrote is picked up by the next anchor tick with no state to remember here.
  //
  // Only the pending frontier depth is read here, so take it as a single index-served count rather
  // than the full `getCrawlStatus` — its catalogue anti-join + by-kind group-by were 144×/day of
  // scans no caller on this path wants (docs/db-scale-backlog Wave 1 #3).
  pass.frontierPending = await countFrontierPending();

  return pass;
}

/** The frontier's by-STATE counts — the one small `crawl_frontier` group-by shared everywhere. */
export type FrontierCounts = {
  frontier: { done: number; failed: number; pending: number; skipped: number };
};

/** The frontier's by-KIND breakdown — computed ONLY by the on-demand admin `catalogue status` read. */
export type FrontierByKind = { artist: number; label: number; release: number };

/**
 * The frontier by-STATE counts — the ONE small `crawl_frontier` group-by, nothing that scans a
 * growing table. This is the lean read the daily funnel snapshot and the crawl pass share: they
 * consume `frontier.done/pending` and never want more. The by-KIND breakdown is split out into
 * `getFrontierByKind` so only `getCrawlStatus` (the on-demand admin read) pays for that second
 * `group by kind` scan of the ~90k-row frontier — the crawl pass fires 144×/day and never renders it
 * (docs/db-scale-backlog Wave 1 #3). `getCrawlStatus` composes both for its full shape.
 */
export async function getFrontierCounts(): Promise<FrontierCounts> {
  const db = await getDb();
  const states = await db.execute("select state, count(*) as n from crawl_frontier group by state");
  const frontier = { done: 0, failed: 0, pending: 0, skipped: 0 };

  for (const row of typedRows<{ n: number; state: CrawlNodeState }>(states.rows)) {
    frontier[row.state] = Number(row.n);
  }

  return { frontier };
}

/**
 * The frontier's by-KIND breakdown — the `group by kind` scan of `crawl_frontier`. Split out of
 * `getFrontierCounts` (docs/db-scale-backlog Wave 1 #3) so ONLY the on-demand `catalogue status`
 * read runs it; the recurring crawl pass and funnel snapshot take the state-only counts.
 */
export async function getFrontierByKind(): Promise<FrontierByKind> {
  const db = await getDb();
  const kinds = await db.execute("select kind, count(*) as n from crawl_frontier group by kind");
  const frontierByKind: FrontierByKind = { artist: 0, label: 0, release: 0 };

  for (const row of typedRows<{ kind: CrawlNodeKind; n: number }>(kinds.rows)) {
    frontierByKind[row.kind] = Number(row.n);
  }

  return frontierByKind;
}

/**
 * The pending frontier depth alone — a single leading-column count that rides
 * `crawl_frontier_pick_idx` (schema.ts, `state` is the index's first column). The `frontierPending`
 * meter the crawl pass and its dry-run report read, WITHOUT the by-state/by-kind group-bys, the
 * catalogue anti-join, the anchor gauge, or `listLabels` that `getCrawlStatus` also runs — the
 * 144×/day scan this hoist removes (docs/db-scale-backlog Wave 1 #3).
 */
export async function countFrontierPending(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "select count(*) as n from crawl_frontier where state = 'pending'",
  );

  return Number(typedRows<{ n: number }>(result.rows)[0]?.n ?? 0);
}

/**
 * The frontier at rest — what the walk holds, what it has drained, and what the operator
 * still has to rule on. The `/status`-shaped read behind `fluncle admin catalogue status`.
 */
export async function getCrawlStatus(): Promise<CrawlStatus> {
  const db = await getDb();
  const [frontierCounts, frontierByKind, catalogue, anchors, labels] = await Promise.all([
    // The by-STATE frontier counts (shared with the funnel snapshot's lean read) and the by-KIND
    // breakdown — the latter computed only here, the on-demand admin read (docs/db-scale-backlog
    // Wave 1 #3), never on the recurring crawl pass.
    getFrontierCounts(),
    getFrontierByKind(),
    // A CATALOGUE track is a `tracks` row with no `findings` row. `findings` is a strict 1:1 subtype
    // of `tracks` on the shared PK, so that anti-join count IS `count(tracks) − count(findings)` — two
    // plain covering-index counts instead of a per-row anti-join probe (docs/db-scale-backlog Wave 1
    // #9), still computed in SQL, never by pulling the table into the isolate.
    db.execute(`select (select count(*) from tracks) - (select count(*) from findings) as n`),
    // The anchor gauge — the ISRC-bearing slice of the un-anchored catalogue, kept on the
    // `tracks_anchor_queue_idx` PARTIAL index so it stays cheap as the table grows. NOTE: the
    // anchor sweep drains a WIDER worklist (`spotify_uri is null`, ISRC or not — track-work.ts
    // `kind: "anchor"`) — this count is the indexed lower-bound gauge, not the full drain set (a
    // no-ISRC row has no partial index to count it cheaply, and counting the whole table on every
    // status read is exactly the growing-table scan the DB rules forbid).
    db.execute(`select count(*) as n from tracks
                where isrc is not null and spotify_uri is null
                  and not exists (select 1 from findings where findings.track_id = tracks.track_id)`),
    listLabels(),
  ]);

  return {
    anchorsPending: Number(typedRows<{ n: number }>(anchors.rows)[0]?.n ?? 0),
    catalogueTracks: Number(typedRows<{ n: number }>(catalogue.rows)[0]?.n ?? 0),
    frontier: frontierCounts.frontier,
    frontierByKind,
    labelsUndecided: labels.filter((label) => label.seedState === "undecided").length,
    seedLabels: labels
      .filter((label) => label.seedState === "enabled")
      .map((label) => label.name)
      .sort(),
  };
}
