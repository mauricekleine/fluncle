#!/usr/bin/env bun
/**
 * The artist LINK backfill — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as
 * part of `db:backfill` on every push, right after the album/label backfills whose exact shape
 * it copies (`backfill-albums.ts` is the template, and its two-step MINT-then-LINK rule is the
 * doctrine here too).
 *
 * There is only a LINK step, and that asymmetry is the point.
 *
 * MINTING an artist entity stays where it was — off a CERTIFIED FINDING, at publish, keyed on
 * the Spotify artist id (`upsertTrackArtists`). An artist Fluncle has never pulled a banger
 * from earns no entity, no `/artist/<slug>` page and no sitemap slot, exactly as an album he has
 * never touched earns none. That rule is what bounds the `artists` table against the catalogue,
 * and this script does not touch it.
 *
 * What was MISSING was the other half: a track the CRAWLER wrote has no Spotify anchor when it
 * lands, so it got no `track_artists` row — and its artist was therefore reachable only through
 * the raw `artists_json` names on the row. Nothing asked that question until `/artist/<slug>`
 * had to show the rest of an artist's catalogue, and answering it through `artists_json` means
 * a full scan of a table that grows without limit — the one shape AGENTS.md flatly forbids.
 *
 * So this stamps the edge for every track whose credited name matches an artist that ALREADY
 * has a row, certified or not, and `/artist/<slug>` reads it as an indexed seek at any
 * catalogue size. It is the self-healing backstop behind the crawler's own per-release call
 * (`linkTracksToArtistEntities`), and the path by which a track written by any writer that
 * knows nothing of the join — an admin update, a future importer — is folded into the graph.
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
