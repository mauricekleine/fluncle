#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AnchorReview, type AnchorReviewSource } from "../src/lib/server/anchor";

export type AnchorReviewSeed = {
  candidate: {
    albumImageUrl?: null | string;
    artists?: (string | { id?: null | string; name: string })[];
    durationMs?: null | number;
    isrc?: null | string;
    source?: AnchorReviewSource;
    spotifyTrackId?: null | string;
    title: string;
  };
  track_id: string;
};

type AnchorReviewSeedSkip =
  | "already_anchored"
  | "already_reviewed"
  | "certified"
  | "invalid"
  | "not_found";

export type AnchorReviewBackfillResult = {
  skipped: { reason: AnchorReviewSeedSkip; trackId: string }[];

  written: string[];
};

function normalizeSeedArtists(
  artists: AnchorReviewSeed["candidate"]["artists"],
): { id: null | string; name: string }[] {
  return (artists ?? []).flatMap((artist) => {
    if (typeof artist === "string") {
      return artist.trim() ? [{ id: null, name: artist }] : [];
    }

    return typeof artist?.name === "string" && artist.name.trim()
      ? [{ id: artist.id ?? null, name: artist.name }]
      : [];
  });
}

export async function backfillAnchorReviews(
  client: Client,
  seeds: AnchorReviewSeed[],
  options: { at?: string; execute?: boolean } = {},
): Promise<AnchorReviewBackfillResult> {
  const { at = new Date().toISOString(), execute = false } = options;
  const result: AnchorReviewBackfillResult = { skipped: [], written: [] };

  for (const seed of seeds) {
    const trackId = seed.track_id?.trim();

    if (!trackId || typeof seed.candidate?.title !== "string" || !seed.candidate.title.trim()) {
      result.skipped.push({ reason: "invalid", trackId: trackId || "(missing id)" });
      continue;
    }

    const found = await client.execute({
      args: [trackId],
      sql: `select t.title, t.spotify_uri, t.anchor_review_json,
                   (f.track_id is not null) as certified
            from tracks t
            left join findings f on f.track_id = t.track_id
            where t.track_id = ?
            limit 1`,
    });
    const row = found.rows[0];

    if (!row) {
      result.skipped.push({ reason: "not_found", trackId });
      continue;
    }

    if (Number(row.certified) === 1) {
      result.skipped.push({ reason: "certified", trackId });
      continue;
    }

    if (row.spotify_uri) {
      result.skipped.push({ reason: "already_anchored", trackId });
      continue;
    }

    if (typeof row.anchor_review_json === "string" && row.anchor_review_json.trim()) {
      result.skipped.push({ reason: "already_reviewed", trackId });
      continue;
    }

    const review: AnchorReview = {
      at,
      candidate: {
        albumImageUrl: seed.candidate.albumImageUrl ?? null,
        artists: normalizeSeedArtists(seed.candidate.artists),
        durationMs: seed.candidate.durationMs ?? 0,
        isrc: seed.candidate.isrc ?? null,
        source: seed.candidate.source ?? "apify",
        spotifyTrackId: seed.candidate.spotifyTrackId ?? null,
        title: seed.candidate.title,
      },
      reason: "version_mismatch",

      title: typeof row.title === "string" ? row.title : "",
    };

    if (execute) {
      await client.execute({
        args: [JSON.stringify(review), trackId],

        sql: `update tracks
              set anchor_review_json = ?
              where track_id = ?
                and spotify_uri is null
                and anchor_review_json is null`,
      });
    }

    result.written.push(trackId);
  }

  return result;
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);

  if (index >= 0) {
    return process.argv[index + 1];
  }

  return process.argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const file = parseArg("file");

  if (!file) {
    throw new Error(
      "--file <scan.json> is required (a JSON array of { track_id, candidate } seeds)",
    );
  }

  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON ARRAY of { track_id, candidate } seeds`);
  }

  const execute = process.argv.includes("--execute");
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );

  try {
    const result = await backfillAnchorReviews(client, parsed as AnchorReviewSeed[], { execute });
    const counts = new Map<AnchorReviewSeedSkip, number>();

    for (const skip of result.skipped) {
      counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
    }

    console.log(
      `${execute ? "wrote" : "would write"} ${result.written.length} review(s) of ${parsed.length} seed(s)`,
    );

    const ordered = [...counts].sort(([left], [right]) => left.localeCompare(right));

    for (const [reason, count] of ordered) {
      console.log(`  skipped ${count} — ${reason}`);
    }

    if (!execute) {
      console.log("dry run — re-run with --execute to write");
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}
