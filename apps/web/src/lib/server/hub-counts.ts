import { type Client } from "@libsql/client";

import { getDb, typedRows } from "./db";
import { markDueWorkSourceMaintenanceStatements } from "./due-work";

export type HubCountEntity = "albums" | "artists" | "labels";

export type HubCountDelta = {
  certified: number;

  renderable: number;
};

export type HubCountArtistDelta = HubCountDelta & { rankable: number };

export type HubCountStatement = { args: Array<null | number | string>; sql: string };

export type HubCountForeignKey = "album_id" | "label_id";

export function isNoopHubCountDelta(delta: HubCountDelta): boolean {
  return delta.certified === 0 && delta.renderable === 0;
}

export function hubCountDeltaStatement(
  entity: HubCountEntity,
  entityId: string,
  delta: HubCountDelta,
): HubCountStatement {
  return {
    args: [delta.renderable, delta.certified, entityId],
    sql: `update ${entity}
            set renderable_track_count = max(0, renderable_track_count + ?),
                certified_finding_count = max(0, certified_finding_count + ?)
          where id = ?`,
  };
}

export function hubCountArtistDeltaStatement(
  artistId: string,
  delta: HubCountArtistDelta,
): HubCountStatement {
  return {
    args: [delta.renderable, delta.certified, delta.rankable, artistId],
    sql: `update artists
            set renderable_track_count = max(0, renderable_track_count + ?),
                certified_finding_count = max(0, certified_finding_count + ?),
                rankable_track_count = max(0, rankable_track_count + ?)
          where id = ?`,
  };
}

export function rankableArtistDeltaForTrackStatement(
  trackId: string,
  delta: -1 | 1,
): HubCountStatement {
  return {
    args: [delta, trackId],
    sql: `update artists
            set rankable_track_count = max(0, rankable_track_count + ?)
          where id in (select artist_id from track_artists where track_id = ?)`,
  };
}

export function repairRankableArtistsForTrackStatement(trackId: string): HubCountStatement {
  return {
    args: [trackId],
    sql: `with affected(id) as (
            select artist_id from track_artists where track_id = ?
          ), truth(id, rankable) as (
            select affected.id, count(tracks.track_id)
            from affected
            left join track_artists artist_tracks indexed by track_artists_artist_id_idx
              on artist_tracks.artist_id = affected.id
            left join tracks on tracks.track_id = artist_tracks.track_id
              and tracks.key is not null and tracks.has_embedding = 1
            group by affected.id
          )
          update artists
          set rankable_track_count = truth.rankable
          from truth
          where artists.id = truth.id
            and artists.rankable_track_count <> truth.rankable`,
  };
}

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

export type HubCountMoveGroup = {
  certified: number;

  fromId: null | string;

  renderable: number;
};

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

export type HubCountCensusRow = {
  certified: bigint | number;
  from_id: null | string;
  renderable: bigint | number;
};

export function toHubCountMoveGroups(rows: readonly HubCountCensusRow[]): HubCountMoveGroup[] {
  return rows.map((row) => ({
    certified: Number(row.certified),
    fromId: row.from_id,
    renderable: Number(row.renderable),
  }));
}

export type HubCountArtistEdge = {
  artistId: string;

  certified: boolean;

  rankable: boolean;
  trackId: string;
};

export function hubCountArtistEdgeStatements(
  edges: readonly HubCountArtistEdge[],
): HubCountStatement[] {
  const seen = new Set<string>();
  const byArtist = new Map<string, HubCountArtistDelta>();

  for (const edge of edges) {
    const key = JSON.stringify([edge.trackId, edge.artistId]);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const delta = byArtist.get(edge.artistId) ?? { certified: 0, rankable: 0, renderable: 0 };
    delta.renderable += 1;

    if (edge.certified) {
      delta.certified += 1;
    }

    if (edge.rankable) {
      delta.rankable += 1;
    }

    byArtist.set(edge.artistId, delta);
  }

  return [...byArtist].map(([artistId, delta]) => hubCountArtistDeltaStatement(artistId, delta));
}

const FOREIGN_KEY: Record<"albums" | "labels", HubCountForeignKey> = {
  albums: "album_id",
  labels: "label_id",
};

export async function relinkTracksToEntity(
  entity: "albums" | "labels",
  entityId: string,
  trackIds: readonly string[],
  client?: Pick<Client, "batch" | "execute">,
): Promise<number> {
  if (trackIds.length === 0) {
    return 0;
  }

  const db = client ?? (await getDb());
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
      ...markDueWorkSourceMaintenanceStatements(
        [
          ...trackIds.map((trackId) => ({ subjectId: trackId, subjectType: "track" as const })),
          ...[...new Set([entityId, ...groups.flatMap((group) => group.fromId ?? [])])].map(
            (subjectId) => ({
              subjectId,
              subjectType: entity === "albums" ? ("album" as const) : ("label" as const),
            }),
          ),
        ],
        {
          producer: "hub-entity-relink",
          publicProjectionImpact: {
            impact: entity === "labels" ? "artist_qualification" : "neither",
            justification:
              entity === "labels"
                ? "This relink writes tracks.label_id."
                : "This relink writes tracks.album_id, which no public projection reads.",
          },
        },
      ),
    ],
    "write",
  );

  return moved;
}
