#!/usr/bin/env bun
/**
 * THE ARTIST-GRAPH ONE-OFF BACKFILL — operator-run, by hand, RESUMABLE. NOT in the deploy chain.
 *
 * IT HITS PRODUCTION TURSO and it hits SPOTIFY. Run it on the operator machine:
 *   `FLUNCLE_TURSO_OP_ITEM="<item>" bun run --cwd apps/web scripts/backfill-artist-graph.ts`
 * Production Turso credentials come from 1Password via `op`, NOT `.dev.vars` (in this repo that
 * points at the tiny LOCAL per-worktree dev DB). Point `FLUNCLE_TURSO_OP_ITEM` at the item holding
 * the production Turso credentials (the same var + item `db-pull-prod.ts` uses), so `op` must be
 * unlocked — that biometric unlock IS the human-in-the-loop gate on touching prod. The Spotify
 * grant is still read from the environment. Print the `nextCursor` it reports and pass it back to
 * resume:
 *   `FLUNCLE_TURSO_OP_ITEM="<item>" bun run --cwd apps/web scripts/backfill-artist-graph.ts <nextCursor>`
 *
 * WHY IT EXISTS. Slice 003 connects a crawled track's artists by their stable `spotify_artist_id`
 * at the Spotify-ANCHOR step (crawl.ts `connectAnchorArtists`). That is the path FROM NOW ON. But a
 * catalogue track anchored BEFORE that path existed was linked only by the fragile NAME-fold (its
 * `track_artists` rows point at artists carrying no `spotify_artist_id`) — or, if its anchor landed
 * before its artist had any row at all, was left with no link. This script catches that HISTORY up:
 * for every catalogue track that carries a `spotify_uri` yet has no artist linked by a STABLE id, it
 * re-fetches the track's Spotify artists and connect-or-creates them by id (`upsertTrackArtists`),
 * so the name-folded rows are re-keyed on the stable id and the anchor-before-mint rows gain a link.
 *
 * IT MINTS NO FINDING. `upsertTrackArtists` only ever writes `artists` + `track_artists`; every read
 * that means "finding" inner-joins `findings … log_id is not null`, so a crawl-minted artist renders
 * its page on its catalogue (bounded by the thin-content floor), never as a certified count. Avatar
 * fetches are left OFF (`fillImages: false`) — the batched `backfill-artist-images` sweep fills them.
 *
 * SCALE — this set may be LARGE (thousands of catalogue tracks, one Spotify `/tracks/{id}` call
 * each). So it is METERED: a bounded `BATCH` per invocation, a small delay between calls, and a hard
 * STOP on the first Spotify 429 (grinding the wall earns a longer ban). It resumes from the printed
 * `nextCursor`; every write is idempotent, so a re-run is safe. See docs/artist-relationship.md.
 */
import { type Client, createClient } from "@libsql/client/web";
import { spotifyTrackIdOf } from "../src/lib/spotify-track-id";
import { fetchTrackMetadata } from "../src/lib/server/spotify";
import { upsertTrackArtists } from "../src/lib/server/artists";

/** Tracks fetched per invocation. One Spotify call each, so this is the per-run Spotify budget. */
const BATCH = 200;

/** Politeness pause between Spotify calls (ms) — steady, well under the throttle wall. */
const DELAY_MS = 200;

/** One catalogue track still lacking a stable-id artist link. */
type UnlinkedTrack = { spotify_uri: string; track_id: string };

/** The track's Spotify artists, names + stable ids in the same order (null = fetch failed). */
type TrackArtists = { ids: string[]; names: string[] } | null;

export type ArtistGraphBackfillResult = {
  /** Tracks whose artists this run connect-or-created by stable id. */
  linked: number;
  /** The last track_id to resume past; null when the scan drained. */
  nextCursor: null | string;
  /** Tracks Spotify could not answer for (no artists / transient) — left for a later run. */
  skipped: number;
  /** True when Spotify threw a 429 and the run stopped early. */
  throttled: boolean;
};

/** Coerce a libSQL scalar cell to text — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Sleep, so the per-call pace stays well under Spotify's throttle. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Spotify 429 surfaces as a plain Error whose message carries the status. */
function isRateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes("429");
}

/**
 * The idempotent core, taking any libSQL client (for the resumable read) plus INJECTABLE Spotify
 * fetch + link functions, so a test can drive it against an in-memory database with neither a live
 * Spotify call nor `upsertTrackArtists`'s own `getDb()`.
 *
 * The worklist: catalogue tracks (no finding) that carry a `spotify_uri` but have NO artist linked
 * by a stable id yet — either name-folded (`track_artists` → an artist with `spotify_artist_id`
 * NULL) or unlinked entirely. Keyset-paged by `track_id`, so a run resumes cleanly from `cursor`.
 */
export async function backfillArtistGraph(
  client: Client,
  fetchArtists: (spotifyTrackId: string) => Promise<TrackArtists>,
  link: (trackId: string, names: string[], ids: string[]) => Promise<void>,
  options: { batch: number; cursor?: string; delayMs: number },
): Promise<ArtistGraphBackfillResult> {
  const result: ArtistGraphBackfillResult = {
    linked: 0,
    nextCursor: null,
    skipped: 0,
    throttled: false,
  };

  const cursor = options.cursor ?? "";
  const rows = (
    await client.execute({
      args: [cursor, options.batch],
      sql: `select track_id, spotify_uri from tracks
            where spotify_uri is not null
              and track_id > ?
              and not exists (select 1 from findings where findings.track_id = tracks.track_id)
              and not exists (
                select 1 from track_artists ta
                join artists a on a.id = ta.artist_id
                where ta.track_id = tracks.track_id and a.spotify_artist_id is not null
              )
            order by track_id
            limit ?`,
    })
  ).rows as unknown as UnlinkedTrack[];

  let lastAttempted = "";

  for (const row of rows) {
    const trackId = asText(row.track_id);
    const spotifyTrackId = spotifyTrackIdOf(asText(row.spotify_uri));

    lastAttempted = trackId;

    // A malformed / non-track URI can never be re-fetched — count it skipped and move on.
    if (!spotifyTrackId) {
      result.skipped += 1;
      continue;
    }

    let artists: TrackArtists;

    try {
      artists = await fetchArtists(spotifyTrackId);
    } catch (error) {
      if (isRateLimited(error)) {
        // Spotify is throttling — stop rather than re-storm. The cursor below resumes safely.
        result.throttled = true;
        break;
      }

      // A transient Spotify fault: skip this track, leave it for a later run.
      result.skipped += 1;
      continue;
    }

    if (!artists || artists.names.length === 0) {
      result.skipped += 1;
    } else {
      await link(trackId, artists.names, artists.ids);
      result.linked += 1;
    }

    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  // Resume past everything attempted; drained (no more work) when the page came back short.
  result.nextCursor = rows.length === options.batch ? lastAttempted || null : null;

  return result;
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

/** Read one field of the prod-Turso 1Password item, exactly as `db-pull-prod.ts` does. */
async function readSecret(field: string): Promise<string> {
  try {
    const value = await Bun.$`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");
  // intMode:"bigint" keeps large integers exact; the script reads only text cells and uses JS array
  // lengths for the batch check, so nothing here needs bigint narrowing.
  const client = createClient({ authToken, intMode: "bigint", url });
  const cursor = process.argv[2];

  const result = await backfillArtistGraph(
    client,
    async (spotifyTrackId) => {
      const meta = await fetchTrackMetadata(spotifyTrackId);
      return { ids: meta.spotifyArtistIds, names: meta.artists };
    },
    (trackId, names, ids) => upsertTrackArtists(trackId, names, ids, { fillImages: false }),
    { batch: BATCH, cursor, delayMs: DELAY_MS },
  );

  console.log(
    `artist-graph backfill: ${result.linked} linked · ${result.skipped} skipped` +
      `${result.throttled ? " (STOPPED — Spotify throttled)" : ""}.`,
  );

  if (result.throttled) {
    // The worklist is self-filtering — a throttled (unlinked) track stays in it — so the honest
    // resume after a 429 is a fresh run from the start; already-linked tracks are simply skipped.
    console.log(
      "  Spotify throttled — wait, then re-run from the start (already-linked tracks are skipped).",
    );
  } else if (result.nextCursor) {
    console.log(
      `  more remain — resume with: bun run --cwd apps/web scripts/backfill-artist-graph.ts ${result.nextCursor}`,
    );
  } else {
    console.log("  scan drained — nothing left to reconcile.");
  }
}

if (import.meta.main) {
  await main();
}
