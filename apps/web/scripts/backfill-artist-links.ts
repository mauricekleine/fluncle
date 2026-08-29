#!/usr/bin/env bun
/**
 * The artist LINK reconciler — IDEMPOTENT, and a ONE-OFF operator run, NO LONGER in the deploy
 * chain. Run it by hand when an artist entity is minted AFTER catalogue tracks crediting it were
 * already written (see "why it is still load-bearing" below):
 *   `bun run --cwd apps/web scripts/backfill-artist-links.ts`
 * It reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally, `.dev.vars`).
 *
 * There is only a LINK step, and that asymmetry is the point.
 *
 * MINTING an artist entity happens on two INLINE paths now: off a CERTIFIED FINDING at publish
 * (`upsertTrackArtists`, keyed on the Spotify artist id), and — since slice 003 — off a crawled
 * track's Spotify ANCHOR, connect-or-created by that same stable id (`connectAnchorArtists`,
 * crawl.ts). A track with no Spotify presence gets its edge from the name-fold at write time
 * (`linkTracksToArtistEntities`), minting nothing. This script mints nothing either.
 *
 * WHY IT IS STILL LOAD-BEARING (and so kept, not deleted). The inline paths link a track against
 * the artist entities that exist AT THAT MOMENT. But an artist entity is often minted LATER — the
 * crawl writes a catalogue track crediting "X" before Fluncle has ever certified X, so at write
 * time there is no X row to link, and if that track was already Spotify-anchored the anchor step
 * won't re-run for it. When X is finally minted (a finding, or another crawl anchor), the older
 * track stays UNLINKED. This reconciler is what folds it in: it stamps the edge for every track
 * whose credited name matches an artist that ALREADY has a row, certified or not, so
 * `/artist/<slug>` reads it as an indexed seek at any catalogue size. It is also the path by which
 * a track written by any writer that knows nothing of the join — an admin update, a future
 * importer — is reconciled. The recurring deploy run was dropped (the inline paths cover the
 * common case); this catch-up is now operator-cadenced.
 *
 * It cannot make a catalogue track countable as a finding: every read that means "finding"
 * inner-joins `findings … log_id is not null`. See `artists.ts` and the rail test beside it.
 *
 * The pass is edge-keyseted and carries the maintained artist counters in the same bounded write
 * batch as each insert, so a completed run needs no whole-corpus counter reseed.
 */
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
  /** `track_artists` rows this run stamped. Zero on a steady-state deploy. */
  linked: number;
};

const PAGE = 200;

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied.
 *
 * `json_each` explodes `artists_json` into one row per credited name and hands back `credit.key`
 * — the 0-based array index, which is exactly the 1-based `position` the column wants. The
 * composite PK `(track_id, artist_id)` absorbs a re-run, so `insert or ignore` makes the whole
 * thing a no-op the second time.
 *
 * A catalogue row that gains an edge here just gained the artist graph the capture gate reads, so
 * it is re-staled for The Ear (RFC artist-primary-capture; catalogue-rank-restale.ts). The
 * new-edge catalogue tracks are read FIRST (the same anti-join `linkTracksToArtistEntities` uses),
 * then nulled — so a steady-state re-run that inserts nothing re-stales nothing.
 */
export async function backfillArtistLinks(client: Client): Promise<ArtistLinksBackfillResult> {
  const linkSelect = `select tracks.track_id, a.id as artist_id, credit.key + 1 as position,
                             tracks.is_catalogue,
                             tracks.key is not null and tracks.has_embedding = 1 as is_rankable
                      from tracks
                      join json_each(tracks.artists_json) credit
                      join artists a on a.name = credit.value collate nocase`;

  let linked = 0;

  for (;;) {
    // Bound one transactional mutation to known track ids. The projection marker, edge insert,
    // and rank re-stale then succeed or roll back together; a restart simply selects the next page.
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
