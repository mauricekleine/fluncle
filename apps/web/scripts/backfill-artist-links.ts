#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restaleCatalogueRankStatements } from "../src/lib/server/catalogue-rank-restale";
import {
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
  markDueWorkSourceMaintenanceStatements,
} from "../src/lib/server/due-work";
import { hubCountArtistEdgeStatements } from "../src/lib/server/hub-counts";

export type ArtistLinksBackfillResult = {
  linked: number;
};

const PAGE = 200;

export async function backfillArtistLinks(client: Client): Promise<ArtistLinksBackfillResult> {
  const linkSelect = `select tracks.track_id, a.id as artist_id, credit.key + 1 as position,
                             tracks.is_catalogue,
                             tracks.key is not null and tracks.has_embedding = 1 as is_rankable
                      from tracks
                      join json_each(tracks.artists_json) credit
                      join artists a on a.name = credit.value collate nocase`;

  let linked = 0;

  for (;;) {
    const pending = await client.execute({
      args: [PAGE],
      sql: `select distinct candidate.track_id, candidate.artist_id, candidate.position,
                            candidate.is_catalogue, candidate.is_rankable
            from (${linkSelect}) candidate
            where not exists (
              select 1 from track_artists ta
              where ta.track_id = candidate.track_id and ta.artist_id = candidate.artist_id
            )
            order by candidate.track_id, candidate.artist_id
            limit ?`,
    });
    const edges = pending.rows.flatMap((row) => {
      const trackId = row["track_id"];
      const artistId = row["artist_id"];
      const position = Number(row["position"]);
      if (
        typeof trackId !== "string" ||
        typeof artistId !== "string" ||
        !Number.isSafeInteger(position)
      ) {
        return [];
      }
      return [
        {
          artistId,
          certified: Number(row["is_catalogue"]) === 0,
          position,
          rankable: Number(row["is_rankable"]) === 1,
          trackId,
        },
      ];
    });
    const trackIds = [...new Set(edges.map((edge) => edge.trackId))];

    if (edges.length === 0) {
      break;
    }

    const [inserted] = await client.batch(
      [
        {
          args: edges.flatMap((edge) => [edge.trackId, edge.artistId, edge.position]),
          sql: `insert or ignore into track_artists (track_id, artist_id, position) values
                ${edges.map(() => "(?, ?, ?)").join(", ")}`,
        },
        ...hubCountArtistEdgeStatements(edges),
        ...restaleCatalogueRankStatements(trackIds),
        ...markDueWorkSourceMaintenanceStatements(
          [
            ...trackIds.map((subjectId) => ({ subjectId, subjectType: "track" as const })),
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { producer: "backfill-artist-links" },
        ),
      ],
      "write",
    );
    linked += inserted?.rowsAffected ?? 0;
  }

  return { linked };
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  const result = await backfillArtistLinks(client);

  console.log(`artist links backfill: ${result.linked} linked.`);
}

if (import.meta.main) {
  await main();
}
