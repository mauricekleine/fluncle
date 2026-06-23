#!/usr/bin/env bun
/**
 * ONE-OFF backfill: upload each finding's custom cover as the thumbnail of its
 * ALREADY-PUBLISHED YouTube Short.
 *
 * Shorts pushed BEFORE commit b16a5db (2026-06-13, "admin posting board +
 * per-platform publishing") still show YouTube's auto-picked frame — custom
 * thumbnails on the push landed with that commit. Postiz can't retro-edit a
 * published video's thumbnail, so this script calls the YouTube Data API
 * `thumbnails.set` directly to upload each finding's `<log-id>/cover.jpg` (from
 * R2) onto its existing Short.
 *
 * THIS HITS YOUTUBE LIVE. It runs by hand, in the morning, deliberately:
 *   - `op` must be UNLOCKED with its CLI integration enabled.
 *   - PROD Turso creds come from 1Password ("Turso Production Credentials" in
 *     the Fluncle vault), exactly like scripts/db-pull-prod.ts.
 *   - The YouTube CLIENT creds come from the same Fluncle local-dev env item the
 *     `.dev.vars.tpl` references — read its 1Password path from
 *     FLUNCLE_1PASSWORD_ENV_ITEM (and FLUNCLE_1PASSWORD_ACCOUNT for the
 *     `--account` flag, if set), like scripts/render-dev-vars.ts.
 *   - The youtube_auth refresh token (the same upload-scoped OAuth credential
 *     from `fluncle admin auth youtube`) is reused via getYouTubeAccessToken();
 *     the `youtube.upload` scope already covers `thumbnails.set`.
 *
 * Standalone `bun run` is NOT in DEV mode, so the lib/server env helpers won't
 * auto-load `.dev.vars`. We populate process.env with the four PROD creds
 * (Turso URL/token + YouTube client id/secret) BEFORE importing any lib/server
 * module, so its lazy `readEnvs` picks them up.
 *
 * SELECTION: youtube `social_posts` rows (status='published') for findings that
 * PREDATE b16a5db (by the youtube row's published_at, falling back to the
 * track's added_at), each matched to a channel upload by NORMALIZED title (with
 * publish-time proximity as the tiebreak). Unmatched candidates and findings
 * whose cover is a confirmed 404/410 are SKIPPED. The API can't tell us whether
 * a video already has a *custom* thumbnail, so the predate-cutoff is the primary
 * selector — re-running is harmless (it just re-sets the same image).
 *
 * Run (DRY-RUN is the default — prints what WOULD change, uploads nothing):
 *   bun run --cwd apps/web backfill:youtube-thumbnails
 * Then, to actually upload:
 *   bun run --cwd apps/web backfill:youtube-thumbnails --apply
 */
import { $ } from "bun";

import {
  type Candidate,
  matchVideoIdForCandidate,
  predatesThumbnailSupport,
  type UploadedVideo,
} from "./backfill-youtube-thumbnails.helpers";

const TURSO_ITEM = "op://Fluncle/Turso Production Credentials";

const apply = process.argv.includes("--apply");

await loadProdCreds();

// Imported AFTER process.env is populated, so the lazy readEnvs inside these
// modules resolve against the PROD creds we just set (not DEV `.dev.vars`).
const { getDb } = await import("../src/lib/server/db");
const { trackMedia } = await import("../src/lib/media");
const { getYouTubeAccessToken } = await import("../src/lib/server/youtube");

type Summary = {
  candidates: number;
  matched: number;
  skippedNoMatch: number;
  skippedCoverAbsent: number;
  uploaded: number;
  failed: number;
};

await main();

async function main(): Promise<void> {
  console.log(
    apply
      ? "Running in APPLY mode — thumbnails WILL be uploaded to YouTube."
      : "Running in DRY-RUN mode (default). Nothing will be uploaded. Pass --apply to upload.",
  );

  const token = await getYouTubeAccessToken();
  const candidates = await loadCandidates();

  console.log(`Found ${candidates.length} predate-cutoff youtube candidate(s).`);

  const uploads = await loadChannelUploads(token);

  console.log(`Enumerated ${uploads.length} channel upload(s).`);

  const summary: Summary = {
    candidates: candidates.length,
    failed: 0,
    matched: 0,
    skippedCoverAbsent: 0,
    skippedNoMatch: 0,
    uploaded: 0,
  };

  for (const candidate of candidates) {
    const videoId = matchVideoIdForCandidate(candidate, uploads);

    if (!videoId) {
      summary.skippedNoMatch += 1;
      console.warn(`SKIP no-match: "${candidate.title}" (log ${candidate.logId})`);
      continue;
    }

    summary.matched += 1;

    const coverUrl = trackMedia(candidate.logId).coverUrl;

    if (await isConfirmedAbsent(coverUrl)) {
      summary.skippedCoverAbsent += 1;
      console.warn(`SKIP cover-absent (404/410): ${coverUrl} (log ${candidate.logId})`);
      continue;
    }

    if (!apply) {
      console.log(
        `WOULD set thumbnail: log=${candidate.logId} title="${candidate.title}" videoId=${videoId} cover=${coverUrl}`,
      );
      continue;
    }

    const ok = await setThumbnail(token, videoId, coverUrl);

    if (ok) {
      summary.uploaded += 1;
      console.log(`SET thumbnail: log=${candidate.logId} videoId=${videoId}`);
    } else {
      summary.failed += 1;
    }
  }

  printSummary(summary);
}

function printSummary(summary: Summary): void {
  console.log("");
  console.log("── Summary ─────────────────────────────");
  console.log(`Candidates (predate cutoff): ${summary.candidates}`);
  console.log(`Matched to an upload:        ${summary.matched}`);
  console.log(`Skipped (no title match):    ${summary.skippedNoMatch}`);
  console.log(`Skipped (cover absent):      ${summary.skippedCoverAbsent}`);

  if (apply) {
    console.log(`Uploaded:                    ${summary.uploaded}`);
    console.log(`Failed:                      ${summary.failed}`);
  } else {
    console.log(`Would upload:                ${summary.matched - summary.skippedCoverAbsent}`);
    console.log("(dry-run — pass --apply to actually upload)");
  }
}

/**
 * Read the four PROD creds from 1Password and assign them into process.env
 * BEFORE any lib/server import, mirroring db-pull-prod.ts (Turso) and
 * render-dev-vars.ts (the env-item path + optional account).
 */
async function loadProdCreds(): Promise<void> {
  const envItem = process.env.FLUNCLE_1PASSWORD_ENV_ITEM?.trim();

  if (!envItem) {
    console.error(
      "Missing FLUNCLE_1PASSWORD_ENV_ITEM. Add the Fluncle local-dev 1Password item path to your shell startup file, then retry.",
    );
    process.exit(1);
  }

  const account = process.env.FLUNCLE_1PASSWORD_ACCOUNT?.trim();

  process.env.TURSO_DATABASE_URL = await readOpSecret(`${TURSO_ITEM}/TURSO_DATABASE_URL`, account);
  process.env.TURSO_AUTH_TOKEN = await readOpSecret(`${TURSO_ITEM}/TURSO_AUTH_TOKEN`, account);
  process.env.YOUTUBE_CLIENT_ID = await readOpSecret(`op://${envItem}/YOUTUBE_CLIENT_ID`, account);
  process.env.YOUTUBE_CLIENT_SECRET = await readOpSecret(
    `op://${envItem}/YOUTUBE_CLIENT_SECRET`,
    account,
  );
}

async function readOpSecret(reference: string, account: string | undefined): Promise<string> {
  try {
    const value = account
      ? await $`op --account ${account} read ${reference}`.text()
      : await $`op read ${reference}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${reference} from 1Password. Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

/**
 * Predate-cutoff youtube candidates: published youtube `social_posts` joined to
 * their track, keeping only findings that predate b16a5db. Publish time is the
 * youtube row's published_at, falling back to the track's added_at (the notNull
 * publish/add time; the tracks table has no published_at column).
 */
async function loadCandidates(): Promise<Candidate[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select t.log_id as log_id,
                 t.title as title,
                 coalesce(sp.published_at, t.added_at) as published_at
          from social_posts sp
          join tracks t on t.track_id = sp.track_id
          where sp.platform = 'youtube'
            and sp.status = 'published'
            and t.log_id is not null`,
  });

  const candidates: Candidate[] = [];

  for (const row of result.rows) {
    const record = row as Record<string, unknown>;
    const logId = record.log_id;
    const title = record.title;
    const publishedAt = record.published_at;

    if (typeof logId !== "string" || typeof title !== "string") {
      continue;
    }

    const publishedAtStr = typeof publishedAt === "string" ? publishedAt : undefined;

    if (!predatesThumbnailSupport(publishedAtStr)) {
      continue;
    }

    candidates.push({ logId, publishedAt: publishedAtStr ?? "", title });
  }

  return candidates;
}

/**
 * Enumerate the authorized channel's uploads: channels.list (mine=true) gives
 * the uploads playlist id, then page playlistItems.list for every video.
 */
async function loadChannelUploads(token: string): Promise<UploadedVideo[]> {
  const channels = await youtubeGet(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    token,
  );
  const channelItems = asArray(channels.items);
  const firstChannel = channelItems[0] as Record<string, unknown> | undefined;
  const contentDetails = firstChannel?.contentDetails as Record<string, unknown> | undefined;
  const relatedPlaylists = contentDetails?.relatedPlaylists as Record<string, unknown> | undefined;
  const uploadsPlaylistId = relatedPlaylists?.uploads;

  if (typeof uploadsPlaylistId !== "string") {
    throw new Error("Could not resolve the channel's uploads playlist id.");
  }

  const uploads: UploadedVideo[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      maxResults: "50",
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const page = await youtubeGet(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
      token,
    );

    for (const item of asArray(page.items)) {
      const record = item as Record<string, unknown>;
      const snippet = record.snippet as Record<string, unknown> | undefined;
      const itemContentDetails = record.contentDetails as Record<string, unknown> | undefined;
      const videoId = itemContentDetails?.videoId;
      const title = snippet?.title;

      if (typeof videoId !== "string" || typeof title !== "string") {
        continue;
      }

      const publishedAt = itemContentDetails?.videoPublishedAt;

      uploads.push({
        publishedAt: typeof publishedAt === "string" ? publishedAt : undefined,
        title,
        videoId,
      });
    }

    const next = page.nextPageToken;
    pageToken = typeof next === "string" ? next : undefined;
  } while (pageToken);

  return uploads;
}

async function youtubeGet(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`YouTube GET ${url} failed: ${response.status} ${body.slice(0, 300)}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * POST the cover bytes to thumbnails.set as a simple media upload. On non-2xx,
 * print the status + a body snippet and return false — one failure must not
 * abort the whole run. Returns true on success.
 */
async function setThumbnail(token: string, videoId: string, coverUrl: string): Promise<boolean> {
  const coverResponse = await fetch(coverUrl);

  if (!coverResponse.ok) {
    console.warn(`SKIP cover fetch failed (${coverResponse.status}): ${coverUrl}`);

    return false;
  }

  const bytes = await coverResponse.arrayBuffer();
  const response = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
    {
      body: bytes,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "image/jpeg",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    const body = await response.text();
    console.warn(
      `FAIL thumbnails.set videoId=${videoId}: ${response.status} ${body.slice(0, 300)}`,
    );

    return false;
  }

  return true;
}

/**
 * Whether a HEAD probe PROVES the cover is gone — only an explicit 404/410
 * counts (older bundles can lack cover.jpg). Mirrors isConfirmedAbsent in
 * lib/server/postiz.ts: a 403, a 5xx, or a network blip is inconclusive and
 * falls through to the upload path, which surfaces a real cover-delivery
 * problem rather than hiding it behind a silent skip.
 */
async function isConfirmedAbsent(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });

    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
