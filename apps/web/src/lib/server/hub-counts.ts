// THE MAINTAINED HUB COUNTS — the write side (docs/db-scale-backlog Wave 2 keystone 2).
//
// `labels`, `albums` and `artists` each carry two stored integers — `renderable_track_count`
// (every track linked to the entity, certified or catalogue) and `certified_finding_count` (the
// subset with a `findings` row) — so the catalogue-scale hub gate can filter and order the SMALL
// entity table instead of grouping the growing `tracks` / `track_artists`. The canonical semantics
// live on the schema (`artists.certified_finding_count`, schema.ts). THIS module is the one place
// that knows how to MOVE them, and every edge-writing path in the app goes through it.
//
// ── THREE RULES, ALL THREE MEASURED ────────────────────────────────────────────────────────
//
// 1. DELTAS, NEVER RECOMPUTE. `+= n` / `-= n` off a set counted ONCE. Recompute-from-truth on a
//    bulk path measured 27,400 ms at 150k hosted against ~200 ms for the delta form — 137× worse.
//    The only place a recompute is allowed is the one-time deploy backfill
//    (`scripts/backfill-hub-counts.ts`) and the future reconciliation sweep.
//
// 2. THE DELTA RIDES THE SAME `db.batch` AS THE EDGE WRITE. A half-applied pair IS drift, and a
//    maintained counter's failure mode is silent. So the builders here return libSQL statement
//    objects rather than executing anything — the caller batches them WITH its own write.
//
// 3. `certified` KEYS OFF `tracks.is_catalogue = 0`, NEVER A `findings` JOIN. Keystone 1 (shipped)
//    materialized that discriminator precisely so this half is a column read.
//
// A delta that matches zero rows is fine and deliberate (a best-effort link whose track vanished,
// an entity already deleted) — the counters are advisory bookkeeping backed by the reconciliation
// sweep, never a correctness gate. The `max(0, …)` clamp is the same posture: a count must never
// read negative, whatever a lost race did.

import { getDb, typedRows } from "./db";

/** The three entity tables that carry the maintained pair. */
export type HubCountEntity = "albums" | "artists" | "labels";

/** How far to move one entity's two counters. Either may be negative or zero. */
export type HubCountDelta = {
  /** Move for `certified_finding_count` — the linked tracks with a `findings` row. */
  certified: number;
  /** Move for `renderable_track_count` — ALL linked tracks. */
  renderable: number;
};

/** A libSQL statement, in the shape `db.batch` / `db.execute` take. */
export type HubCountStatement = { args: Array<null | number | string>; sql: string };

/** The `tracks` column that carries the entity edge (artists ride `track_artists` instead). */
export type HubCountForeignKey = "album_id" | "label_id";

/** True when neither counter would move — the caller can skip the statement entirely. */
export function isNoopHubCountDelta(delta: HubCountDelta): boolean {
  return delta.certified === 0 && delta.renderable === 0;
}

/**
 * Move ONE entity row's two counters by `delta`. Clamped at zero (a maintained counter that ever
 * read negative would be worse than one that is merely stale) and deliberately does NOT touch
 * `updated_at`: a count move is internal bookkeeping, not a public fact about the entity, exactly
 * like `tracks.is_catalogue`.
 */
export function hubCountDeltaStatement(
  entity: HubCountEntity,
  entityId: string,
  delta: HubCountDelta,
): HubCountStatement {
  // `entity` is a closed union of literal table names, never caller input; libSQL has no bind
  // slot for an identifier.
  return {
    args: [delta.renderable, delta.certified, entityId],
    sql: `update ${entity}
            set renderable_track_count = max(0, renderable_track_count + ?),
                certified_finding_count = max(0, certified_finding_count + ?)
          where id = ?`,
  };
}

/**
 * Move the two counters on EVERY artist credited on one track — the certify fan-out. The artist
 * set comes from a subselect over `track_artists` (a PK-prefix seek on the composite key), so no
 * ids have to travel through the isolate and the statement can ride the certify batch verbatim.
 */
export function hubCountDeltaForTrackArtistsStatement(
  trackId: string,
  delta: HubCountDelta,
): HubCountStatement {
  return {
    args: [delta.renderable, delta.certified, trackId],
    sql: `update artists
            set renderable_track_count = max(0, renderable_track_count + ?),
                certified_finding_count = max(0, certified_finding_count + ?)
          where id in (select artist_id from track_artists where track_id = ?)`,
  };
}

/** One row of the pre-move census a bulk re-point reads before it writes. */
export type HubCountMoveGroup = {
  /** How many of the moved tracks are CERTIFIED (`is_catalogue = 0`). */
  certified: number;
  /** The entity the tracks pointed at BEFORE the move — null when they pointed nowhere. */
  fromId: null | string;
  /** How many tracks are in this group. */
  renderable: number;
};

/**
 * THE BULK RE-POINT ARITHMETIC, as a pure function so it is testable without a database.
 *
 * Given the pre-move census (one group per OLD pointer value) and the entity the tracks are all
 * being pointed at, returns the statements that debit each old entity and credit the new one.
 * Groups that already point at `toId` contribute nothing — an idempotent re-link must not inflate
 * the count — and a null `fromId` (tracks that pointed nowhere) is a pure credit with no debit.
 */
export function hubCountMoveStatements(
  entity: HubCountEntity,
  toId: string,
  groups: readonly HubCountMoveGroup[],
): HubCountStatement[] {
  const statements: HubCountStatement[] = [];
  let movedCertified = 0;
  let movedRenderable = 0;

  for (const group of groups) {
    if (group.fromId === toId) {
      // Already pointed here: the UPDATE is a no-op for these rows, so the counters must not move.
      continue;
    }

    movedCertified += group.certified;
    movedRenderable += group.renderable;

    if (group.fromId !== null) {
      statements.push(
        hubCountDeltaStatement(entity, group.fromId, {
          certified: -group.certified,
          renderable: -group.renderable,
        }),
      );
    }
  }

  const credit: HubCountDelta = { certified: movedCertified, renderable: movedRenderable };

  if (!isNoopHubCountDelta(credit)) {
    statements.push(hubCountDeltaStatement(entity, toId, credit));
  }

  return statements;
}

/**
 * The census read a bulk re-point runs BEFORE its UPDATE: for a bounded set of track ids, one
 * grouped row per current pointer value carrying the group size and its certified share.
 *
 * Bounded by the caller's batch (a crawled release, a tapped label page — tens of rows), and the
 * whole reason the bulk paths cost ~200 ms instead of the banned 27 s recompute: the moved set is
 * counted ONCE here, then the totals are arithmetic.
 */
export function hubCountCensusQuery(
  foreignKey: HubCountForeignKey,
  trackIds: readonly string[],
): HubCountStatement {
  const placeholders = trackIds.map(() => "?").join(", ");

  return {
    args: [...trackIds],
    sql: `select ${foreignKey} as from_id, count(*) as renderable,
                 sum(case when is_catalogue = 0 then 1 else 0 end) as certified
          from tracks
          where track_id in (${placeholders})
          group by ${foreignKey}`,
  };
}

/** The raw census row shape `hubCountCensusQuery` returns (libSQL hands back numbers/bigints). */
export type HubCountCensusRow = {
  certified: bigint | number;
  from_id: null | string;
  renderable: bigint | number;
};

/** Normalize the census rows into the arithmetic's input. */
export function toHubCountMoveGroups(rows: readonly HubCountCensusRow[]): HubCountMoveGroup[] {
  return rows.map((row) => ({
    certified: Number(row.certified),
    fromId: row.from_id,
    renderable: Number(row.renderable),
  }));
}

/** One `track_artists` edge that is genuinely NEW, with the certification of the track it links. */
export type HubCountArtistEdge = {
  artistId: string;
  /** The track's `is_catalogue = 0` reading — whether this edge also moves the certified half. */
  certified: boolean;
  trackId: string;
};

/**
 * THE ARTIST-EDGE ARITHMETIC — per-artist deltas for a set of NEW `track_artists` edges.
 *
 * WHY THE CALLER MUST HAND OVER "NEW" EDGES AND NOT LET SQL COUNT THEM. The artist-edge writes are
 * `insert … on conflict do update set position` (the publish/anchor upsert) and `insert or ignore`
 * (the crawl name-fold, the two credit backfills). `rowsAffected` on the FIRST counts the conflict
 * rows too, so it cannot drive a delta at all; and neither form gives PER-ARTIST attribution when
 * one statement inserts many artists. So every caller diffs the intended edges against the existing
 * edge set — a bounded read over its own batch — and passes only what will really be created.
 *
 * Duplicate `(trackId, artistId)` pairs are folded, because a track whose `artists_json` names the
 * same artist twice yields two candidate rows and the composite PK stores one.
 */
export function hubCountArtistEdgeStatements(
  edges: readonly HubCountArtistEdge[],
): HubCountStatement[] {
  const seen = new Set<string>();
  const byArtist = new Map<string, HubCountDelta>();

  for (const edge of edges) {
    const key = `${edge.trackId} ${edge.artistId}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const delta = byArtist.get(edge.artistId) ?? { certified: 0, renderable: 0 };
    delta.renderable += 1;

    if (edge.certified) {
      delta.certified += 1;
    }

    byArtist.set(edge.artistId, delta);
  }

  return [...byArtist].map(([artistId, delta]) =>
    hubCountDeltaStatement("artists", artistId, delta),
  );
}

/** The `tracks` column each entity's edge lives in. */
const FOREIGN_KEY: Record<"albums" | "labels", HubCountForeignKey> = {
  albums: "album_id",
  labels: "label_id",
};

/**
 * THE ONE BULK RE-POINT PRIMITIVE — point a bounded set of tracks at one label/album and move the
 * maintained counters to match, in a single atomic batch.
 *
 * Every bulk link path in the app is this shape: the crawler's per-release label/album stamp, the
 * freshness tap's per-page stamp. The UPDATE is an UNCONDITIONAL overwrite (`set label_id = ?`), so
 * a re-point old → new is genuinely possible and the counters must debit the old entity — which is
 * why the census read comes first. Idempotent: a set already pointing here moves nothing.
 *
 * Returns how many tracks actually MOVED (the `rowsAffected` of the UPDATE counts rows re-written,
 * including the ones already pointing here, so it is not the same number).
 */
export async function relinkTracksToEntity(
  entity: "albums" | "labels",
  entityId: string,
  trackIds: readonly string[],
): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = await getDb();
  const foreignKey = FOREIGN_KEY[entity];
  const census = await db.execute(hubCountCensusQuery(foreignKey, trackIds));
  const groups = toHubCountMoveGroups(typedRows<HubCountCensusRow>(census.rows));
  const placeholders = trackIds.map(() => "?").join(", ");
  const moved = groups.reduce(
    (total, group) => (group.fromId === entityId ? total : total + group.renderable),
    0,
  );

  await db.batch(
    [
      {
        args: [entityId, ...trackIds],
        sql: `update tracks set ${foreignKey} = ?
              where track_id in (${placeholders})`,
      },
      ...hubCountMoveStatements(entity, entityId, groups),
    ],
    "write",
  );

  return moved;
}
