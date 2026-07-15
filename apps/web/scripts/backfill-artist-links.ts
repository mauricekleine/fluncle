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
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ArtistLinksBackfillResult = {
  /** `track_artists` rows this run stamped. Zero on a steady-state deploy. */
  linked: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied.
 *
 * `json_each` explodes `artists_json` into one row per credited name and hands back `credit.key`
 * — the 0-based array index, which is exactly the 1-based `position` the column wants. The
 * composite PK `(track_id, artist_id)` absorbs a re-run, so `insert or ignore` makes the whole
 * thing a no-op the second time.
 */
export async function backfillArtistLinks(client: Client): Promise<ArtistLinksBackfillResult> {
  const result = await client.execute({
    sql: `insert or ignore into track_artists (track_id, artist_id, position)
          select tracks.track_id, a.id, credit.key + 1
          from tracks
          join json_each(tracks.artists_json) credit
          join artists a on a.name = credit.value collate nocase`,
  });

  return { linked: result.rowsAffected };
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
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillArtistLinks(client);

  console.log(`artist links backfill: ${result.linked} linked.`);
}

if (import.meta.main) {
  await main();
}
