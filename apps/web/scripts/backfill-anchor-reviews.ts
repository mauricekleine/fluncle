#!/usr/bin/env bun
/**
 * SEED the suspected-version-mismatch review queue from a scan — the one-off catch-up for rows the
 * live gate will not revisit.
 *
 * The gate now records a near-match the moment it misses (lib/server/anchor.ts §
 * `detectVersionMismatch`), so the queue fills itself from here on. But the rows this feature exists
 * for have ALREADY missed — repeatedly, for months — and many have hit `ANCHOR_MAX_ATTEMPTS`, which
 * means the worklist will never offer them again and the gate will never get another chance to
 * notice. An offline scan over the archive can spot them; this script writes what it found onto the
 * rows so they surface in the /admin attention queue like any freshly-detected one.
 *
 * ── WHAT IT WILL AND WILL NOT DO ─────────────────────────────────────────────────────────────
 * It writes ONE column and nothing else: `tracks.anchor_review_json`. It never anchors, never
 * stamps, never touches the retry counter, and never certifies — so the worst a wrong input can do
 * is put a question in front of the operator, which he answers with `resolve_anchor_review` exactly
 * as he would a live detection. The never-wrong-stamp rail is not reachable from here.
 *
 * It SKIPS, and reports, a row that: does not exist; is CERTIFIED (a finding's Spotify id is its
 * identity, not an anchor to fill); is already ANCHORED (the miss it describes is over); or already
 * carries a review (the live gate's note is fresher than a scan's, and a re-run must not churn it).
 * That last guard is what makes the script IDEMPOTENT: a second run writes zero rows.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────────────
 *   bun run apps/web/scripts/backfill-anchor-reviews.ts --file <scan.json> [--execute]
 *
 * DRY RUN BY DEFAULT (the `migrate_preview_archive` discipline): without `--execute` it reads,
 * decides, and prints the verdict per row without writing. The input is a JSON array of
 * `{ track_id, candidate }`, where `candidate` carries the near-match the scan found:
 *
 *   [
 *     {
 *       "track_id": "mb_9f0c…",
 *       "candidate": {
 *         "title": "Typical Description (Calibre Remix)",
 *         "artists": [{ "name": "Calibre", "id": "sp-calibre" }],
 *         "durationMs": 394000,
 *         "isrc": "GBCJY1300173",
 *         "spotifyTrackId": "3n9…",
 *         "albumImageUrl": "https://i.scdn.co/image/…",
 *         "source": "listenbrainz"
 *       }
 *     }
 *   ]
 *
 * `artists` also accepts bare strings (`["Calibre"]`) — a scan that only carried names loses the
 * stable-id artist link on ACCEPT and nothing else. `spotifyTrackId` is OPTIONAL: a candidate
 * without one (a Deezer-rung suspect) still seeds a queue row, but as INFORMATION — Accept is not
 * offered, and the operator uses the MusicBrainz link to fix the metadata upstream instead.
 */
import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AnchorReview, type AnchorReviewSource } from "../src/lib/server/anchor";

/** One row of the scan's output — deliberately loose, because a scan is a script, not a contract. */
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

/** Why a seed did not land — reported per row so a scan's misses are never silent. */
export type AnchorReviewSeedSkip =
  | "already_anchored"
  | "already_reviewed"
  | "certified"
  | "invalid"
  | "not_found";

export type AnchorReviewBackfillResult = {
  /** `track_id` → why it was skipped, in input order. */
  skipped: { reason: AnchorReviewSeedSkip; trackId: string }[];
  /** Rows that received (or, on a dry run, WOULD receive) a review. */
  written: string[];
};

/** Normalise the scan's artists into the stored `{ id, name }` shape; a bare string loses no name. */
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

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory database
 * with the real migrations applied. `execute: false` (the default) decides everything and writes
 * nothing, so the operator sees the exact verdict list before committing to it.
 */
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

    // The row's own state decides, not the scan's: it may have anchored, been certified, or picked up
    // a fresher review since the scan ran.
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
      // The row's title AS IT STANDS — the other half of the evidence, read from the database rather
      // than trusted from the scan so the queue shows what the operator is actually deciding about.
      title: typeof row.title === "string" ? row.title : "",
    };

    if (execute) {
      await client.execute({
        args: [JSON.stringify(review), trackId],
        // The guards above are re-asserted in SQL so a concurrent anchor (the box's sweep runs on its
        // own timer) cannot be overwritten by a decision this loop made a moment earlier.
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

    // Alphabetical by reason, so two runs of the same scan print the same report.
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
