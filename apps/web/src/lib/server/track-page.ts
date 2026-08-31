// THE ARCHIVE TRACK DESTINATION — the server half of `/track/<trackId>`.
//
// Read `lib/track-page.ts` first: it holds the decision (why the address is the row's primary key)
// and the client-safe half of the identity rule. This file owns the two SQL PREDICATES that the
// destination, the sitemap, and the page's own robots directive all read, and the three reads
// behind them.
//
// ── THE TWO PREDICATES, AND WHY THERE ARE EXACTLY TWO ─────────────────────────────────────────
// They answer different questions and must not be collapsed:
//
//   SUFFICIENT IDENTITY ({@link TRACK_PAGE_IDENTITY_WHERE}) decides whether a page EXISTS. It is
//   the lowest honest bar — the archive can name the recording, and no operator stamp has retired
//   it. Below it there is nothing to serve, so the route 404s.
//
//   EVIDENCE ({@link TRACK_PAGE_INDEXABLE_WHERE}) decides whether a page is INDEXED. A page that
//   clears identity but not evidence still serves 200, still carries its links, and is still
//   crawlable and citable — it simply renders `noindex, follow` and stays out of the sitemap. That
//   is the same posture `/identity/<key>` and a below-floor `/album/<slug>` already take.
//
// ── ONE DEFINITION, TWO CONSUMERS ─────────────────────────────────────────────────────────────
// The gate and the sitemap MUST agree, or the archive submits URLs that refuse to be indexed and
// orphans ones that would. They agree here BY CONSTRUCTION rather than by convention: the page
// does not recompute the rule in TypeScript from the row it loaded — it asks the DATABASE to
// evaluate {@link TRACK_PAGE_INDEXABLE_WHERE} as a column of the same select that loads the row
// (`indexable` below), which is the identical string the sitemap read puts in its `where`. There
// is one expression, in one constant. `track-page.test.ts` and `sitemap-data.integration.test.ts`
// pin the agreement over real rows.
//
// ── WHY THE EVIDENCE RULE IS A CONJUNCTION OF SIMPLE TERMS ────────────────────────────────────
// It could have been a weighted score, and a score would have been prettier and unusable. This
// predicate runs over the whole `tracks` table for the sitemap — a table the crawler grows without
// bound — so it has to stay a shape the planner can drive off an index. Leading it with
// `is_catalogue = 1` puts the read on `tracks_is_catalogue_idx` (the maintained mirror of the
// tracks/findings split, INTERNAL bookkeeping that may be selected on and never rendered) and
// bounds the scan to the catalogue slice, and every remaining term is a plain null test on a
// column. AGENTS.md's database rules are not advice here: this is the one query in the unit that
// touches every row.
//
// The four terms are what a reader needs for the page to be worth landing on:
//   - it belongs to a RECORD (`album_id`), so the page sits in the graph rather than dangling;
//   - it is DATED (`release_date`), so it can be placed in time;
//   - it has a COVER (`album_image_url`), so it is a page about a record rather than a text stub;
//   - it can SEND YOU SOMEWHERE (`spotify_url` or `apple_music_url`), which is the whole errand.
// Tempo, key, ISRC, label, preview and neighbours ride along when the archive holds them and are
// deliberately NOT gates — they are enrichment, and gating on them would make indexability
// oscillate with a sweep's backlog.
//
// ── WHY `is_catalogue = 1` IS PART OF THE EVIDENCE RULE AND NOT AN OVERSIGHT ───────────────────
// A CERTIFIED track's destination is `/log/<coordinate>`, unchanged, forever; `/track/<trackId>`
// for one is a permanent redirect there (see `routes/-track-page-data.ts`). A redirect must never
// appear in a sitemap — a sitemap is a submission for indexing and a 301 is a refusal to be the
// thing indexed — so the certified half is excluded here, and its pages are already carried by the
// `findings` child.

import { readEmbeddingBlob, toVectorProbe } from "./embedding";
import { getDb, typedRow, typedRows } from "./db";
import { isSonarTrackEnabled, searchSonar, type SonarMatch } from "./sonar";
import { bestAlbumCoverUrl } from "../media";
import { discogsReleaseUrl } from "./discogs";
import { parseArtistsJson } from "./artists";

/**
 * SUFFICIENT IDENTITY, in SQL. The client-side twin is `hasTrackPageIdentity` — the same two name
 * clauses — plus the one thing a rendered row cannot see: `dismissed_at`, the operator's stamp for
 * "this is not to be shown". A stamped DUPLICATE is deliberately NOT excluded here: it still has
 * identity, and the route answers it with a permanent redirect to its principal rather than a 404.
 *
 * The alias is fixed at `tracks`, the `REC_ELIGIBLE_WHERE` precedent: a consumer joins under that
 * name or does not use this fragment.
 */
export const TRACK_PAGE_IDENTITY_WHERE = `trim(tracks.title) <> ''
      and tracks.artists_json is not null and trim(tracks.artists_json) not in ('', '[]')
      and tracks.dismissed_at is null`;

/**
 * EVIDENCE, in SQL — the single definition the page's `robots` directive and the sitemap's
 * membership both read. See the header for why each term is here and why it is a conjunction.
 */
export const TRACK_PAGE_INDEXABLE_WHERE = `tracks.is_catalogue = 1
      and tracks.duplicate_of_track_id is null
      and ${TRACK_PAGE_IDENTITY_WHERE}
      and tracks.album_id is not null
      and tracks.release_date is not null
      and tracks.album_image_url is not null
      and (tracks.spotify_url is not null or tracks.apple_music_url is not null)`;

/** One outbound listening destination the archive actually holds for a recording. */
export type ListenDestination = {
  href: string;
  /** The service's own name — what the control says out loud, and its icon key. */
  kind: "apple" | "beatport" | "deezer" | "spotify" | "youtube";
};

/** A graph node this recording hangs off, when the archive has resolved one. */
export type TrackGraphLink = { name: string; slug: string | undefined };

/**
 * A sonically-near recording, in the register it belongs to. `logId` present ⇒ it is a finding and
 * the row leads to its coordinate; absent ⇒ it leads to its own destination. Nothing on this shape
 * names a tier, because the tier has no public name (docs/album-entity.md).
 */
export type SonicNeighbour = {
  albumImageUrl: string | undefined;
  artists: string[];
  logId: string | undefined;
  title: string;
  trackId: string;
};

/** Everything one archive track's destination renders, and nothing the page does not print. */
export type TrackDestination = {
  album: TrackGraphLink | undefined;
  albumImageUrl: string | undefined;
  artists: TrackGraphLink[];
  bpm: number | undefined;
  durationMs: number;
  /**
   * The DATABASE's verdict on {@link TRACK_PAGE_INDEXABLE_WHERE} for this row — never recomputed
   * here. The page turns it into `robots`; the sitemap turns the same expression into membership.
   */
  indexable: boolean;
  /** The Discogs release page — structured-data `sameAs` only, never a listening control. */
  discogsReleaseUrl: string | undefined;
  isrc: string | undefined;
  key: string | undefined;
  label: TrackGraphLink | undefined;
  listen: ListenDestination[];
  mbRecordingId: string | undefined;
  /**
   * Whether the page offers its bounded preview control. TRUE when the archive holds a short-source
   * anchor the `/api/preview` relay can resolve from — a stored 30s preview URL, or an ISRC the
   * relay's Deezer/Apple rungs look up on demand. FALSE renders no control at all, rather than a
   * button that fails: a dead affordance is worse than an absent one.
   */
  previewable: boolean;
  releaseDate: string | undefined;
  title: string;
  trackId: string;
};

/** What the resolver needs to decide between serving, redirecting, and 404ing. */
export type TrackPageRow =
  | { kind: "found"; track: TrackDestination }
  /** A stamped duplicate: the destination is its principal's, permanently. */
  | { kind: "duplicate"; principalTrackId: string }
  /** A certified finding: the destination is `/log/<coordinate>`, permanently and unchanged. */
  | { kind: "certified"; logId: string }
  | { kind: "missing" };

type DestinationRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  album_name: string | null;
  album_slug: string | null;
  apple_music_url: string | null;
  artist_slugs_json: string | null;
  artists_json: string;
  beatport_url: string | null;
  bpm: number | null;
  deezer_track_id: string | null;
  dismissed_at: string | null;
  duplicate_of_track_id: string | null;
  duration_ms: number;
  in_release_id: number | null;
  indexable: number;
  isrc: string | null;
  key: string | null;
  label: string | null;
  label_slug: string | null;
  log_id: string | null;
  mb_recording_id: string | null;
  preview_url: string | null;
  principal_log_id: string | null;
  release_date: string | null;
  title: string;
  track_id: string;
  youtube_video_id: string | null;
  youtube_video_official: number | null;
};

/**
 * The `track_artists → artists` JSON subquery — `[{name, slug}]` for the row's credits, one
 * indexed seek. Lifted verbatim from the `/tracks` hub read (`tracks-hub.ts`), so an artist name
 * resolves to its `/artist/<slug>` page the same way on the hub and on the destination.
 */
const ARTIST_SLUGS_SELECT = `(select json_group_array(json_object('name', a.name, 'slug', a.slug))
     from track_artists ta join artists a on a.id = ta.artist_id
     where ta.track_id = tracks.track_id) as artist_slugs_json`;

const DESTINATION_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  tracks.bpm, tracks.key, tracks.duration_ms, tracks.release_date, tracks.isrc, tracks.mb_recording_id,
  tracks.label, tracks.preview_url, tracks.spotify_url, tracks.apple_music_url, tracks.beatport_url,
  tracks.deezer_track_id, tracks.youtube_video_id, tracks.youtube_video_official, tracks.in_release_id,
  tracks.dismissed_at, tracks.duplicate_of_track_id, findings.log_id,
  (select name from albums where albums.id = tracks.album_id) as album_name,
  (select slug from albums where albums.id = tracks.album_id) as album_slug,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  (select slug from labels where labels.id = tracks.label_id) as label_slug,
  ${ARTIST_SLUGS_SELECT},
  (select log_id from findings where findings.track_id = tracks.duplicate_of_track_id)
    as principal_log_id,
  (case when ${TRACK_PAGE_INDEXABLE_WHERE} then 1 else 0 end) as indexable`;

/** Fold the artist-credit JSON into a display-name → slug map, keyed on the raw vendor spelling. */
function artistSlugMap(json: string | null): Map<string, string> {
  const map = new Map<string, string>();

  if (!json) {
    return map;
  }

  try {
    const parsed: unknown = JSON.parse(json);

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const name = (entry as Record<string, unknown>)["name"];
        const slug = (entry as Record<string, unknown>)["slug"];

        if (typeof name === "string" && typeof slug === "string" && slug) {
          map.set(name.trim().toLowerCase(), slug);
        }
      }
    }
  } catch {
    return map;
  }

  return map;
}

/**
 * The outbound destinations, in the order the page offers them: the two the evidence rule accepts
 * as "somewhere to hear it" first, then the rest of what the archive happens to hold.
 *
 * EVERY entry is a link the archive STORES. Nothing here is composed from a search term or a
 * guess: a wrong link is worse than an absent one, which is the same bar `apple_music_url` and
 * `beatport_url` already clear (exact-by-ISRC or nothing). YouTube rides its officialness gate —
 * an unverified upload is not a listening destination Fluncle points at.
 */
function listenDestinations(row: DestinationRow, spotifyUrl: string | null): ListenDestination[] {
  const destinations: ListenDestination[] = [];

  if (spotifyUrl) {
    destinations.push({ href: spotifyUrl, kind: "spotify" });
  }

  if (row.apple_music_url) {
    destinations.push({ href: row.apple_music_url, kind: "apple" });
  }

  if (row.deezer_track_id) {
    destinations.push({
      href: `https://www.deezer.com/track/${encodeURIComponent(row.deezer_track_id)}`,
      kind: "deezer",
    });
  }

  if (row.beatport_url) {
    destinations.push({ href: row.beatport_url, kind: "beatport" });
  }

  if (row.youtube_video_id && row.youtube_video_official === 1) {
    destinations.push({
      href: `https://www.youtube.com/watch?v=${encodeURIComponent(row.youtube_video_id)}`,
      kind: "youtube",
    });
  }

  // Discogs is deliberately NOT here. It is a release DATABASE, not somewhere to hear a record,
  // and this band promises one thing: a control that plays you the track. The URL is still served
  // — it rides the structured data's `sameAs`, where it belongs, as another page naming the same
  // recording.

  return destinations;
}

function graphLink(name: string | null, slug: string | null): TrackGraphLink | undefined {
  return name?.trim() ? { name, slug: slug ?? undefined } : undefined;
}

/**
 * Read one archive track's destination by its permanent id.
 *
 * The join to `findings` is a LEFT join, and that word is the whole shape of this read: every
 * other single-track read in the archive drives through the inner finding join because it is about
 * a CERTIFICATION. This one is about the RECORDING, so it resolves for a track Fluncle has never
 * ruled on — and it reads `findings.log_id` only to hand the route the one thing it needs to send
 * a certified track home to `/log`.
 */
export async function readTrackDestination(trackId: string): Promise<TrackPageRow> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ${DESTINATION_SELECT}, tracks.spotify_url as spotify_url
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.track_id = ?
          limit 1`,
  });
  const row = typedRow<DestinationRow & { spotify_url: string | null }>(result.rows);

  if (!row) {
    return { kind: "missing" };
  }

  // ORDER IS THE CONTRACT. A certified track's one destination is its coordinate, so that answer
  // outranks everything below it — including the duplicate stamp, because a certified row is never
  // stamped as a copy of something else. Then the duplicate redirect, then the identity floor.
  if (row.log_id) {
    return { kind: "certified", logId: row.log_id };
  }

  if (row.duplicate_of_track_id) {
    // ONE HOP, NEVER TWO. `duplicate_of_track_id` is written only on a catalogue row and only when
    // its ISRC exactly matches a FINDING's (schema.ts), so the principal is nearly always certified
    // — and bouncing to `/track/<principal>` would only 301 again, to `/log`. A chained redirect
    // costs a crawler a round trip and dilutes what it passes, so the coordinate is read in the
    // same select and the twin lands on the real page directly. The `/track` arm below stays for
    // the case the column's rule does not cover: a principal that carries no coordinate.
    return row.principal_log_id
      ? { kind: "certified", logId: row.principal_log_id }
      : { kind: "duplicate", principalTrackId: row.duplicate_of_track_id };
  }

  const artistNames = parseArtistsJson(row.artists_json);

  if (row.dismissed_at || !row.title.trim() || artistNames.length === 0) {
    return { kind: "missing" };
  }

  const slugs = artistSlugMap(row.artist_slugs_json);

  return {
    kind: "found",
    track: {
      album: graphLink(row.album_name, row.album_slug),
      // The best display cover, chosen at the same boundary every other surface chooses it — the
      // album's owned master when the sweep resolved one, else the Spotify chain upgraded to 640².
      albumImageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      artists: artistNames.map((name) => ({
        name,
        slug: slugs.get(name.trim().toLowerCase()),
      })),
      bpm: row.bpm ?? undefined,
      discogsReleaseUrl:
        row.in_release_id === null ? undefined : discogsReleaseUrl(row.in_release_id),
      durationMs: row.duration_ms,
      indexable: row.indexable === 1,
      isrc: row.isrc ?? undefined,
      key: row.key ?? undefined,
      label: graphLink(row.label, row.label_slug),
      listen: listenDestinations(row, row.spotify_url),
      mbRecordingId: row.mb_recording_id ?? undefined,
      // A stored clip, or an ISRC the relay's own rungs can resolve one from. Both are the same
      // bounded short-source media every other Fluncle surface previews; neither is a full song.
      previewable: Boolean(row.preview_url ?? row.isrc),
      releaseDate: row.release_date ?? undefined,
      title: row.title,
      trackId: row.track_id,
    },
  };
}

/** How many neighbours the destination offers. Small on purpose: a band, not a second page. */
export const SONIC_NEIGHBOUR_LIMIT = 8;

type NeighbourRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;
  log_id: string | null;
  title: string;
  track_id: string;
};

const NEIGHBOUR_SELECT = `tracks.track_id, tracks.title, tracks.artists_json, tracks.album_image_url,
  (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
  (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
  (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at,
  findings.log_id`;

/**
 * The candidate set for a sonic neighbour, stated once. It is the destination's own identity rule
 * plus the duplicate stamp — a neighbour must be somewhere a reader can actually go, and every
 * row that clears this either has a `/log` coordinate or has a `/track` destination.
 */
const NEIGHBOUR_WHERE = `${TRACK_PAGE_IDENTITY_WHERE} and tracks.duplicate_of_track_id is null`;

function toNeighbour(row: NeighbourRow): SonicNeighbour {
  return {
    albumImageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    artists: parseArtistsJson(row.artists_json),
    logId: row.log_id ?? undefined,
    title: row.title,
    trackId: row.track_id,
  };
}

/**
 * The N sonically-nearest recordings to one archive track — the destination's "keep going" band,
 * and the half of the cold-arrival journey that makes the archive traversable rather than a set of
 * orphan pages.
 *
 * ── IT IS THE WHOLE ARCHIVE, BOTH REGISTERS ───────────────────────────────────────────────────
 * `/log`'s "more like this" (`getSimilarFindings`) asks a question about FINDINGS and scans the
 * certified corpus. This one asks a question about MUSIC, so it scans `tracks` through a LEFT
 * join and a certified neighbour competes on exactly the same terms as an uncertified one — the
 * `/mix` rail's reasoning, applied to adjacency. The register a neighbour renders in is decided
 * by whether it carries a coordinate, never by the query.
 *
 * ── THE SCALE RULES, ALL FOUR OF THEM ─────────────────────────────────────────────────────────
 * The probe binds as a RAW BLOB, never as text (`toVectorProbe`; a 14× cliff hosted that does not
 * reproduce locally). The ranking happens IN SQL and returns the ~8 winners, never a column of
 * vectors into the isolate. There is exactly ONE probe, so it is one pass over the candidates —
 * never `union all` branches over a CTE, which the planner flattens into one scan per branch. And
 * there is no `libsql_vector_idx`: an ANN index on a populated table wedges hosted Turso's write
 * path, so this is an exact scan, which also means 100% recall.
 *
 * The scan is bounded by the EMBEDDED corpus (the join to `track_embeddings` is inner, so an
 * un-embedded row never reaches the cosine), and sonar is the lever when that corpus outgrows the
 * scan — see the flag below and docs/vector-serving.md.
 *
 * Returns `[]`, never throws, when the track is unknown, carries no embedding yet, or nothing else
 * is embedded. The page renders the band only when it is non-empty, so a dark sonar, an empty
 * corpus and an un-embedded track all degrade to the same honest thing: no band at all.
 */
export async function listSonicNeighbours(
  trackId: string,
  limit = SONIC_NEIGHBOUR_LIMIT,
): Promise<SonicNeighbour[]> {
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  const targetResult = await db.execute({
    args: [trackId],
    sql: `select emb.embedding_blob from track_embeddings emb where emb.track_id = ? limit 1`,
  });
  const target = readEmbeddingBlob(
    typedRow<{ embedding_blob: unknown }>(targetResult.rows)?.embedding_blob,
  );

  if (!target) {
    return [];
  }

  // THE SONAR ROUTE (dark by default). Its filter mirrors NEIGHBOUR_WHERE's two stamp clauses;
  // sonar carries no title/artist metadata, so the hydrator re-asserts the identity half below —
  // the `hydrateSimilarFindings` defence, applied to the wider corpus. Any failure, timeout,
  // unprovisioned env, or empty answer falls through to the exact Turso scan.
  if (await isSonarTrackEnabled()) {
    const matches = await searchSonar({
      excludeIds: [trackId],
      filter: { dismissed: false, is_duplicate: false },
      index: "tracks",
      probes: [target],
      topK: limit,
    });

    if (matches && matches.length > 0) {
      return hydrateNeighbours(matches);
    }
  }

  const result = await db.execute({
    args: [toVectorProbe(target), trackId, limit],
    sql: `select ${NEIGHBOUR_SELECT},
                 vector_distance_cos(emb.embedding_blob, ?) as dist
          from tracks
          left join findings on findings.track_id = tracks.track_id
          join track_embeddings emb on emb.track_id = tracks.track_id
          where tracks.track_id != ? and ${NEIGHBOUR_WHERE}
          order by dist asc, tracks.track_id asc
          limit ?`,
  });

  return typedRows<NeighbourRow>(result.rows).map((row) => toNeighbour(row));
}

/** Hydrate sonar's ranked ids IN SONAR'S ORDER, re-asserting the candidate rule it cannot express. */
async function hydrateNeighbours(matches: SonarMatch[]): Promise<SonicNeighbour[]> {
  const ids = matches.map((match) => match.id);
  const placeholders = ids.map(() => "?").join(", ");
  const db = await getDb();
  const result = await db.execute({
    args: ids,
    sql: `select ${NEIGHBOUR_SELECT}
          from tracks
          left join findings on findings.track_id = tracks.track_id
          where tracks.track_id in (${placeholders}) and ${NEIGHBOUR_WHERE}`,
  });
  const byId = new Map(typedRows<NeighbourRow>(result.rows).map((row) => [row.track_id, row]));

  return ids.flatMap((id) => {
    const row = byId.get(id);

    return row ? [toNeighbour(row)] : [];
  });
}

/** One `/track/<id>` row in the sitemap. Cover art rides as the Google Images extension. */
export type TrackSitemapRow = { imageLoc: string | undefined; trackId: string };

/**
 * How many `/track/<id>` pages are indexable — the tracks child's line in the sitemap index.
 *
 * It is a `count(*)` over {@link TRACK_PAGE_INDEXABLE_WHERE}, whose leading `is_catalogue = 1`
 * puts it on the partial catalogue index rather than a full table walk, and it returns ONE ROW.
 * The index document is edge-cached, so this is paid once per cache window, never per crawler.
 */
export async function countIndexableTrackPages(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `select count(*) as total from tracks where ${TRACK_PAGE_INDEXABLE_WHERE}`,
  );

  return Number(typedRow<{ total: number }>(result.rows)?.total ?? 0);
}

/**
 * ONE PAGE of the tracks sitemap child, windowed IN SQL.
 *
 * Every other sitemap kind reads its whole bag and lets the builder slice it, because every other
 * kind is bounded by what Fluncle has certified or by how many entities exist. This one is bounded
 * by the CRAWL, which is six figures and climbing, so reading the whole bag to emit one child would
 * pull a six-figure column into a 128 MB isolate — precisely the shape AGENTS.md forbids. The
 * window moves into the query instead, and `lib/sitemap.ts` marks this kind pre-sliced so the
 * builder does not window it a second time.
 *
 * The order is `track_id` — a primary key, so it is stable while the crawl grows underneath a
 * crawler that is walking the children one at a time. A date order would reshuffle between fetches
 * and hand the same page out twice while orphaning another.
 */
export async function listTrackSitemapRows(
  limit: number,
  offset: number,
): Promise<TrackSitemapRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit, offset],
    sql: `select tracks.track_id, tracks.album_image_url,
                 (select image_key from albums where albums.id = tracks.album_id) as album_image_key,
                 (select image_state from albums where albums.id = tracks.album_id) as album_image_state,
                 (select image_updated_at from albums where albums.id = tracks.album_id) as album_image_updated_at
          from tracks
          where ${TRACK_PAGE_INDEXABLE_WHERE}
          order by tracks.track_id
          limit ? offset ?`,
  });

  return typedRows<{
    album_image_key: string | null;
    album_image_state: string | null;
    album_image_updated_at: string | null;
    album_image_url: string | null;
    track_id: string;
  }>(result.rows).map((row) => ({
    imageLoc: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    trackId: row.track_id,
  }));
}
