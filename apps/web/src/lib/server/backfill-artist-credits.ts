import { getDb, typedRows } from "./db";
import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
} from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { adoptArtistMbid, mintArtistByMbid } from "./artists";
import { buildArtistFoldMap, loadAliases, loadArtists } from "./backfill-artist-edges";
import { restaleCatalogueRankStatements } from "./catalogue-rank-restale";
import { hubCountArtistEdgeStatements } from "./hub-counts";
import { fold } from "./track-match";
import { logEvent } from "./log";
import { mbFetch } from "./musicbrainz";
import { recordingMbidFromTrackId } from "./recording-mbids";

export const MAX_BATCH = 40;

const RESPONSE_BUDGET_MS = 60_000;

const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

export type ArtistCreditsBackfillResult = {
  dryRun: boolean;

  scanned: number;

  mintedArtists: number;

  matchedArtists: number;

  adoptedArtists: number;

  edgesWritten: number;

  skippedNoIdentity: number;

  rateLimited: boolean;

  nextCursor: string | null;
  ok: true;
};

type MbArtistCredit = { artist?: { id?: string; name?: string }; name?: string };
type MbRecordingCredits = { "artist-credit"?: MbArtistCredit[] };

type CreditEdge = { artistId: string; position: number };

type ResolveOutcome =
  | { kind: "edged"; edges: CreditEdge[]; minted: number; matched: number; adopted: number }
  | { kind: "rate-limited" };

type CreditResolution = { artistId: string; outcome: "matched" | "adopted" | "minted" };
type CreditResolver = (name: string, mbid: string) => Promise<CreditResolution>;

function createCreditResolver(
  corpus: ReadonlyArray<{ id: string; mbid: string | null; name: string }>,
  aliases: ReadonlyArray<{ alias: string; artist_id: string }>,
): CreditResolver {
  const foldMap = buildArtistFoldMap(corpus, aliases);
  const mbidByArtistId = new Map<string, string | null>();
  const mbidToArtistId = new Map<string, string>();

  for (const artist of corpus) {
    mbidByArtistId.set(artist.id, artist.mbid);

    if (artist.mbid) {
      mbidToArtistId.set(artist.mbid, artist.id);
    }
  }

  return async (name, mbid) => {
    const byMbid = mbidToArtistId.get(mbid);

    if (byMbid !== undefined) {
      return { artistId: byMbid, outcome: "matched" };
    }

    const foldedId = foldMap.get(fold(name));

    if (foldedId !== undefined && (mbidByArtistId.get(foldedId) ?? null) === null) {
      await adoptArtistMbid(foldedId, mbid);
      mbidByArtistId.set(foldedId, mbid);
      mbidToArtistId.set(mbid, foldedId);

      return { artistId: foldedId, outcome: "adopted" };
    }

    const newId = await mintArtistByMbid(name, mbid);
    mbidByArtistId.set(newId, mbid);
    mbidToArtistId.set(mbid, newId);

    return { artistId: newId, outcome: "minted" };
  };
}

async function resolveRecordingCredits(
  mbid: string,
  resolve: CreditResolver,
): Promise<ResolveOutcome> {
  const { data, rateLimited } = await mbFetch<MbRecordingCredits>(
    `/recording/${encodeURIComponent(mbid)}?inc=artist-credits`,
  );

  if (rateLimited) {
    return { kind: "rate-limited" };
  }

  const credits = data?.["artist-credit"] ?? [];

  const edges: CreditEdge[] = [];
  const seen = new Set<string>();
  let minted = 0;
  let matched = 0;
  let adopted = 0;

  for (let i = 0; i < credits.length; i++) {
    const credit = credits[i];
    const artistMbid = credit?.artist?.id;
    const artistName = credit?.artist?.name ?? credit?.name;

    if (!artistMbid || artistMbid === VARIOUS_ARTISTS_MBID || !artistName) {
      continue;
    }

    const { artistId, outcome } = await resolve(artistName, artistMbid);

    if (outcome === "minted") {
      minted += 1;
    } else if (outcome === "adopted") {
      adopted += 1;
    } else {
      matched += 1;
    }

    if (seen.has(artistId)) {
      continue;
    }

    seen.add(artistId);
    edges.push({ artistId, position: i + 1 });
  }

  return { adopted, edges, kind: "edged", matched, minted };
}

type WorkRow = {
  is_catalogue?: bigint | number;

  is_rankable?: bigint | number;
  mb_recording_id: string | null;
  track_id: string;
};

async function listWork(
  db: Awaited<ReturnType<typeof getDb>>,
  limit: number,
  cursor: string | undefined,
): Promise<WorkRow[]> {
  const result = await db.execute({
    args: cursor ? [cursor, limit] : [limit],
    sql: cursor
      ? `select t.track_id, t.mb_recording_id, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is not null
           and t.artist_credits_backfilled_at is null
           and t.track_id > ?
         order by t.track_id asc
         limit ?`
      : `select t.track_id, t.mb_recording_id, t.is_catalogue,
                t.key is not null and t.has_embedding = 1 as is_rankable
         from tracks t
         left join track_artists ta on ta.track_id = t.track_id
         where ta.track_id is null
           and t.artist_edges_backfilled_at is not null
           and t.artist_credits_backfilled_at is null
         order by t.track_id asc
         limit ?`,
  });

  return typedRows<WorkRow>(result.rows);
}

async function hydrateProjectedWork(
  db: Awaited<ReturnType<typeof getDb>>,
  trackIds: readonly string[],
): Promise<WorkRow[]> {
  if (trackIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    args: [...trackIds],
    sql: `select track_id, mb_recording_id, is_catalogue,
                 key is not null and has_embedding = 1 as is_rankable
          from tracks
          where track_id in (${trackIds.map(() => "?").join(", ")})`,
  });
  const byId = new Map(typedRows<WorkRow>(result.rows).map((row) => [row.track_id, row]));

  return trackIds.flatMap((trackId) => {
    const row = byId.get(trackId);
    return row === undefined ? [] : [row];
  });
}

async function insertEdges(
  db: Awaited<ReturnType<typeof getDb>>,
  trackId: string,
  edges: ReadonlyArray<CreditEdge>,
  certified: boolean,
  rankable: boolean,
): Promise<number> {
  if (edges.length === 0) {
    return 0;
  }

  const values = edges.map(() => "(?, ?, ?)").join(", ");
  const args = edges.flatMap((edge) => [trackId, edge.artistId, edge.position]);

  const results = await db.batch(
    [
      {
        args,
        sql: `insert or ignore into track_artists (track_id, artist_id, position) values ${values}`,
      },
      ...hubCountArtistEdgeStatements(
        edges.map((edge) => ({ artistId: edge.artistId, certified, rankable, trackId })),
      ),

      ...restaleCatalogueRankStatements([trackId]),
      ...markDueWorkSourceMaintenanceStatements(
        [
          { subjectId: trackId, subjectType: "track" },
          {
            subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
            subjectType: "track",
          },
          ...edges.map((edge) => ({ subjectId: edge.artistId, subjectType: "artist" as const })),
        ],
        { producer: "artist-credit-edges" },
      ),
    ],
    "write",
  );

  return results[0]?.rowsAffected ?? 0;
}

async function stampVisited(db: Awaited<ReturnType<typeof getDb>>, trackId: string): Promise<void> {
  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [new Date().toISOString(), trackId],
        sql: `update tracks set artist_credits_backfilled_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { producer: "artist-credit-stamp" },
  );
}

export async function resolveArtistCredits(
  limit: number,
  dryRun: boolean,
  cursor?: string,
): Promise<ArtistCreditsBackfillResult> {
  const db = await getDb();
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const dueWorkCutoverEnabled = await isDueWorkCutoverEnabled();
  let rows: WorkRow[];

  if (dueWorkCutoverEnabled) {
    const page = await readPromotedDueWorkPage(db, "artist-credits", {
      continuation: cursor
        ? {
            sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
            subjectId: cursor,
          }
        : undefined,
      limit: batchLimit,
    });
    rows = await hydrateProjectedWork(db, page.subjectIds);
  } else {
    rows = await listWork(db, batchLimit, cursor);
  }

  let scanned = 0;
  let mintedArtists = 0;
  let matchedArtists = 0;
  let adoptedArtists = 0;
  let edgesWritten = 0;
  let skippedNoIdentity = 0;
  let rateLimited = false;
  let budgetPaused = false;
  let lastHandledTrackId: string | null = null;
  const deadline = Date.now() + RESPONSE_BUDGET_MS;

  if (dryRun) {
    return {
      adoptedArtists: 0,
      dryRun,
      edgesWritten: 0,
      matchedArtists: 0,
      mintedArtists: 0,
      nextCursor: rows.length < batchLimit ? null : (rows.at(-1)?.track_id ?? null),
      ok: true,
      rateLimited: false,
      scanned: rows.length,
      skippedNoIdentity: 0,
    };
  }

  if (rows.length === 0) {
    return {
      adoptedArtists: 0,
      dryRun,
      edgesWritten: 0,
      matchedArtists: 0,
      mintedArtists: 0,
      nextCursor: null,
      ok: true,
      rateLimited: false,
      scanned: 0,
      skippedNoIdentity: 0,
    };
  }

  const [corpus, aliases] = await Promise.all([loadArtists(db), loadAliases(db)]);
  const resolve = createCreditResolver(corpus, aliases);

  for (const row of rows) {
    if (Date.now() >= deadline) {
      budgetPaused = true;
      logEvent("info", "artist-credits.budget-pause", { handled: scanned, pageSize: rows.length });
      break;
    }

    const mbid = row.mb_recording_id ?? recordingMbidFromTrackId(row.track_id);

    if (!mbid) {
      await stampVisited(db, row.track_id);
      skippedNoIdentity += 1;
      scanned += 1;
      lastHandledTrackId = row.track_id;
      continue;
    }

    const outcome = await resolveRecordingCredits(mbid, resolve);

    if (outcome.kind === "rate-limited") {
      rateLimited = true;
      break;
    }

    edgesWritten += await insertEdges(
      db,
      row.track_id,
      outcome.edges,

      row.is_catalogue !== undefined && Number(row.is_catalogue) === 0,
      row.is_rankable !== undefined && Number(row.is_rankable) === 1,
    );
    mintedArtists += outcome.minted;
    matchedArtists += outcome.matched;
    adoptedArtists += outcome.adopted;
    await stampVisited(db, row.track_id);
    scanned += 1;
    lastHandledTrackId = row.track_id;

    logEvent("info", "artist-credits.resolved", {
      adopted: outcome.adopted,
      edges: outcome.edges.length,
      matched: outcome.matched,
      minted: outcome.minted,
      trackId: row.track_id,
    });
  }

  const lastTrackId = rows.at(-1)?.track_id ?? null;
  const nextCursor = rateLimited
    ? null
    : budgetPaused
      ? lastHandledTrackId
      : rows.length < batchLimit
        ? null
        : lastTrackId;

  return {
    adoptedArtists,
    dryRun,
    edgesWritten,
    matchedArtists,
    mintedArtists,
    nextCursor,
    ok: true,
    rateLimited,
    scanned,
    skippedNoIdentity,
  };
}
