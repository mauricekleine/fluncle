#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { spotifyTrackIdOf } from "../src/lib/spotify-track-id";
import { fetchTrackMetadata } from "../src/lib/server/spotify";
import { upsertTrackArtists } from "../src/lib/server/artists";

const BATCH = 200;

const DELAY_MS = 200;

type UnlinkedTrack = { spotify_uri: string; track_id: string };

type TrackArtists = { ids: string[]; names: string[] } | null;

export type ArtistGraphBackfillResult = {
  linked: number;

  nextCursor: null | string;

  skipped: number;

  throttled: boolean;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes("429");
}

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

    if (!spotifyTrackId) {
      result.skipped += 1;
      continue;
    }

    let artists: TrackArtists;

    try {
      artists = await fetchArtists(spotifyTrackId);
    } catch (error) {
      if (isRateLimited(error)) {
        result.throttled = true;
        break;
      }

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

  result.nextCursor = rows.length === options.batch ? lastAttempted || null : null;

  return result;
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

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

  const client = createClient({
    authToken,
    concurrency: REMOTE_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });
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
