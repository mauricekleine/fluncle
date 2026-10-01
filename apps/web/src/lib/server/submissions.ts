import { type Submission, type SubmissionSource, type SubmissionStatus } from "@fluncle/contracts";
import { type SubmissionBody } from "@fluncle/contracts/orpc";
import { publicTrackWhere } from "../../db/public-track-visibility";

export type { Submission };

import { createHash, randomUUID } from "node:crypto";
import { parseArtistsJson } from "./artists";
import { getDeezerSubmissionTrack } from "./deezer";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { getPublicSession } from "./public-auth";
import { assertRateLimit } from "./rate-limit";
import {
  ApiError,
  fetchTrackMetadata,
  findSpotifyTrackByIsrc,
  parseSpotifyTrackUrl,
  SpotifyDeferredError,
  spotifyDeferredApiError,
  type TrackMetadata,
} from "./spotify";
import { normalizeIsrc, splitTitle } from "./track-match";

const noteMaxLength = 500;
const contactMaxLength = 120;
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxSubmissions = 5;

const triageVerdictMinLength = 4;
const triageVerdictMaxLength = 200;

export type SubmissionInput = SubmissionBody;

type SubmissionRow = {
  id: string;
  spotify_track_id: string;
  spotify_url: string;
  title: string;
  artists_json: string;
  album: string | null;
  artwork_url: string | null;
  note: string | null;
  contact: string | null;
  source: SubmissionSource;
  status: SubmissionStatus;
  created_at: string;
  reviewed_at: string | null;
  triage_verdict: string | null;
};

type PublishedTrackRow = {
  added_to_spotify: number;
  posted_to_telegram: number;
  track_id: string;
};

export async function createSubmission(
  body: SubmissionInput,
  request: Request,
): Promise<Submission> {
  const input = validateSubmissionInput(body);
  const db = await getDb();
  const submitterHash = hashSubmitter(request);
  const publicUser = await getPublicSession(request);
  const createdAt = new Date().toISOString();

  await assertRateLimit({
    action: "submit_track",
    limit: rateLimitMaxSubmissions,
    message: "Too many submissions from this connection. Try again later.",
    request,
    userId: publicUser?.id,
    windowMs: rateLimitWindowMs,
  });

  let spotifyTrackId = input.spotifyTrackId;
  let track: TrackMetadata;

  if (input.deezerTrackId || input.catalogueTrackId) {
    const candidate = input.deezerTrackId
      ? await getDeezerSubmissionTrack(input.deezerTrackId).catch((error: unknown) => {
          throw submissionExternalError(error);
        })
      : await getCatalogueSubmissionTrack(input.catalogueTrackId ?? "");

    if (!candidate) {
      throw new ApiError("invalid_request", "Invalid submission", 400);
    }

    try {
      const anchoredId = "spotifyTrackId" in candidate ? candidate.spotifyTrackId : undefined;

      if (anchoredId) {
        spotifyTrackId = anchoredId;
        track = await fetchTrackMetadata(anchoredId, "essential");
      } else {
        const isrc = normalizeIsrc(candidate.isrc);
        const durationMs = candidate.durationMs;

        if (!isrc || typeof durationMs !== "number" || durationMs <= 0) {
          throw new ApiError("invalid_request", "Invalid submission", 400);
        }

        const lookup = await findSpotifyTrackByIsrc(isrc, "essential");

        if (lookup.rateLimited) {
          throw new ApiError(
            "spotify_rate_limited",
            "I can't check Spotify right now. Try again later.",
            429,
          );
        }

        if (lookup.unauthorized) {
          throw new ApiError(
            "submission_unavailable",
            "I can't check Spotify right now. Try again later.",
            503,
          );
        }

        if (!lookup.match) {
          throw new ApiError(
            "submission_unavailable",
            "I can't find this track on Spotify yet. Try again later.",
            503,
          );
        }

        spotifyTrackId = lookup.match.trackId;

        if (!spotifyTrackId) {
          throw new ApiError("invalid_request", "Invalid submission", 400);
        }

        track = await fetchTrackMetadata(spotifyTrackId, "essential");

        if (!matchesSubmissionCandidate({ durationMs, isrc, title: candidate.title }, track)) {
          throw new ApiError("invalid_request", "Invalid submission", 400);
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_request") {
        throw error;
      }

      throw submissionExternalError(error);
    }
  }

  if (!spotifyTrackId) {
    throw new ApiError("invalid_request", "Invalid submission", 400);
  }

  track ??= await fetchTrackMetadata(spotifyTrackId, "essential").catch((error: unknown) => {
    throw submissionExternalError(error);
  });
  const submission: Submission = {
    album: track.album,
    artists: track.artists,
    artworkUrl: track.albumImageUrl,
    contact: input.contact,
    createdAt,
    id: randomUUID(),
    note: input.note,
    source: input.source,
    spotifyTrackId: track.trackId,
    spotifyUrl: track.spotifyUrl,
    status: "pending",
    title: track.title,
  };

  await db.execute({
    args: [
      submission.id,
      submission.spotifyTrackId,
      submission.spotifyUrl,
      submission.title,
      JSON.stringify(submission.artists),
      submission.album ?? null,
      submission.artworkUrl ?? null,
      submission.note ?? null,
      submission.contact ?? null,
      submission.source,
      submission.status,
      submission.createdAt,
      null,
      submitterHash,
      publicUser?.id ?? null,
    ],
    sql: `insert into submissions (
        id,
        spotify_track_id,
        spotify_url,
        title,
        artists_json,
        album,
        artwork_url,
        note,
        contact,
        source,
        status,
        created_at,
        reviewed_at,
        submitter_hash,
        user_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  try {
    await notifyDiscord(submission);
  } catch (error) {
    logEvent("warn", "submissions.discord-notify-failed", { error, submissionId: submission.id });
  }

  return submission;
}

function matchesSubmissionCandidate(
  candidate: { durationMs: number; isrc: string; title: string },
  track: { durationMs?: number; isrc?: string; title: string },
): boolean {
  return (
    normalizeIsrc(candidate.isrc) === normalizeIsrc(track.isrc ?? null) &&
    splitTitle(candidate.title).base === splitTitle(track.title).base &&
    typeof track.durationMs === "number" &&
    Math.abs(candidate.durationMs - track.durationMs) <= 3_000
  );
}

function submissionExternalError(error: unknown): ApiError {
  if (error instanceof SpotifyDeferredError) {
    return spotifyDeferredApiError(error);
  }

  if (error instanceof ApiError && (error.status === 429 || error.status === 503)) {
    return error;
  }

  if (error instanceof Error && /^Spotify API request failed: 404(?:\s|$)/.test(error.message)) {
    return new ApiError("invalid_request", "Invalid selected track id", 400);
  }

  if (
    error instanceof Error &&
    (error.message.includes("429") ||
      error.message.includes("QUOTA_EXCEEDED") ||
      "retryAfterMs" in error)
  ) {
    return new ApiError(
      "spotify_rate_limited",
      "I can't check Spotify right now. Try again later.",
      429,
    );
  }

  return new ApiError(
    "submission_unavailable",
    "I can't log your track right now. Try again later.",
    503,
  );
}

export async function listPendingSubmissions(): Promise<Submission[]> {
  const db = await getDb();
  const result = await db.execute({
    args: ["pending"],
    sql: `select
        id,
        spotify_track_id,
        spotify_url,
        title,
        artists_json,
        album,
        artwork_url,
        note,
        contact,
        source,
        status,
        created_at,
        reviewed_at,
        triage_verdict
      from submissions
      where status = ?
      order by created_at asc`,
  });

  return typedRows<SubmissionRow>(result.rows).map(rowToSubmission);
}

export async function getSubmission(id: string): Promise<Submission> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `select
        id,
        spotify_track_id,
        spotify_url,
        title,
        artists_json,
        album,
        artwork_url,
        note,
        contact,
        source,
        status,
        created_at,
        reviewed_at,
        triage_verdict
      from submissions
      where id = ?
      limit 1`,
  });
  const row = typedRow<SubmissionRow>(result.rows);

  if (!row) {
    throw new ApiError("submission_not_found", "Submission not found", 404);
  }

  return rowToSubmission(row);
}

export async function rejectSubmission(id: string): Promise<Submission> {
  const submission = await getSubmission(id);

  if (submission.status !== "pending") {
    throw new ApiError("invalid_status", "Only pending submissions can be rejected", 409);
  }

  await updateSubmissionStatus(id, "rejected");

  return getSubmission(id);
}

export async function approveSubmission(id: string): Promise<Submission> {
  const submission = await getSubmission(id);

  if (submission.status !== "pending") {
    throw new ApiError("invalid_status", "Only pending submissions can be approved", 409);
  }

  const db = await getDb();
  const publishedResult = await db.execute({
    args: [submission.spotifyTrackId],
    sql: `select track_id, added_to_spotify, posted_to_telegram
      from findings
      where track_id = ?
      limit 1`,
  });
  const published = typedRow<PublishedTrackRow>(publishedResult.rows);

  if (!published || !published.added_to_spotify || !published.posted_to_telegram) {
    throw new ApiError(
      "not_published",
      "Submission must be published through admin add before it can be marked approved",
      409,
    );
  }

  await updateSubmissionStatus(id, "approved");

  return getSubmission(id);
}

export function gateTriageVerdict(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_verdict", "A `verdict` (the triage one-liner) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < triageVerdictMinLength) {
    throw new ApiError(
      "verdict_too_short",
      `The verdict is too short (${trimmed.length} < ${triageVerdictMinLength} chars)`,
      422,
    );
  }

  if (trimmed.length > triageVerdictMaxLength) {
    throw new ApiError(
      "verdict_too_long",
      `The verdict is too long (${trimmed.length} > ${triageVerdictMaxLength} chars)`,
      422,
    );
  }

  return trimmed;
}

export async function triageSubmission(
  id: string,
  verdict: unknown,
  promptVersion?: number | null,
): Promise<Submission> {
  const gated = gateTriageVerdict(verdict);
  const submission = await getSubmission(id);

  if (submission.status !== "pending") {
    throw new ApiError("invalid_status", "Only pending submissions can be triaged", 409);
  }

  const db = await getDb();

  const result = await db.execute({
    args: [gated, promptVersion ?? null, id, "pending"],
    sql: `update submissions
      set triage_verdict = ?, triage_prompt_version = ?
      where id = ?
        and status = ?`,
  });

  if (result.rowsAffected === 0) {
    throw new ApiError("invalid_status", "Only pending submissions can be triaged", 409);
  }

  return getSubmission(id);
}

export function validateSubmissionInput(body: SubmissionInput): {
  catalogueTrackId?: string;
  contact?: string;
  deezerTrackId?: string;
  note?: string;
  source: SubmissionSource;
  spotifyTrackId?: string;
} {
  if (typeof body.honeypot === "string" && body.honeypot.trim()) {
    throw new ApiError("invalid_request", "Invalid submission", 400);
  }

  const legacyId = typeof body.spotifyTrackId === "string" ? body.spotifyTrackId.trim() : "";
  const legacyProvider =
    !body.spotifyUrl && /^[1-9]\d*$/.test(legacyId)
      ? "deezer"
      : !body.spotifyUrl && /^mb_[A-Za-z0-9_-]+$/.test(legacyId)
        ? "catalogue"
        : undefined;
  const deezerTrackId =
    body.deezerTrackId === undefined && legacyProvider !== "deezer"
      ? undefined
      : requireText(body.deezerTrackId ?? legacyId, "Missing selected track id");
  const catalogueTrackId =
    body.catalogueTrackId === undefined && legacyProvider !== "catalogue"
      ? undefined
      : requireText(body.catalogueTrackId ?? legacyId, "Missing selected track id");

  if (deezerTrackId && catalogueTrackId) {
    throw new ApiError("invalid_request", "Invalid submission", 400);
  }

  const spotifyTrackId =
    deezerTrackId || catalogueTrackId
      ? undefined
      : requireText(body.spotifyTrackId, "Missing selected track id");
  const spotifyUrl =
    deezerTrackId || catalogueTrackId
      ? undefined
      : requireText(body.spotifyUrl, "Missing selected Spotify URL");
  const source = parseSource(body.source);
  optionalText(body.album, 160);
  optionalText(body.artworkUrl, 600);
  const note = optionalText(body.note, noteMaxLength);
  const contact = optionalText(body.contact, contactMaxLength);

  if (deezerTrackId && !/^[1-9]\d*$/.test(deezerTrackId)) {
    throw new ApiError("invalid_request", "Invalid selected track id", 400);
  }

  if (spotifyTrackId && !/^[A-Za-z0-9]{22}$/.test(spotifyTrackId)) {
    throw new ApiError("invalid_request", "Invalid selected track id", 400);
  }

  const urlTrackId = spotifyUrl ? parseSpotifyTrackUrl(spotifyUrl) : undefined;

  if (urlTrackId !== spotifyTrackId) {
    throw new ApiError("invalid_request", "Selected track id does not match Spotify URL", 400);
  }

  return {
    catalogueTrackId,
    contact,
    deezerTrackId,
    note,
    source,
    spotifyTrackId,
  };
}

async function getCatalogueSubmissionTrack(trackId: string): Promise<
  | {
      artists: string[];
      durationMs: number | null;
      isrc: string | null;
      spotifyTrackId?: string;
      title: string;
    }
  | undefined
> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select tracks.title, tracks.artists_json, tracks.duration_ms, tracks.isrc, tracks.spotify_uri
          from tracks left join findings on findings.track_id = tracks.track_id
          where tracks.track_id = ? and ${publicTrackWhere("tracks", "findings")}
          limit 1`,
  });
  const row = typedRow<{
    artists_json: string;
    duration_ms: number | null;
    isrc: string | null;
    spotify_uri: string | null;
    title: string;
  }>(result.rows);

  if (!row) {
    return undefined;
  }

  const spotifyTrackId = row.spotify_uri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];

  if (!spotifyTrackId && (!row.isrc || !row.duration_ms || row.duration_ms <= 0)) {
    return undefined;
  }

  return {
    artists: parseArtistsJson(row.artists_json),
    durationMs: row.duration_ms,
    isrc: row.isrc,
    spotifyTrackId,
    title: row.title,
  };
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_request", message, 400);
  }

  return value.trim().slice(0, 300);
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_request", "Invalid text field", 400);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    throw new ApiError(
      "invalid_request",
      `Text fields must be ${maxLength} characters or less`,
      400,
    );
  }

  return trimmed;
}

function parseSource(value: unknown): SubmissionSource {
  if (value === "web" || value === "cli" || value === "ssh") {
    return value;
  }

  throw new ApiError("invalid_request", "Invalid submission source", 400);
}

async function updateSubmissionStatus(id: string, status: "approved" | "rejected"): Promise<void> {
  const db = await getDb();
  const result = await db.execute({
    args: [status, new Date().toISOString(), id, "pending"],
    sql: `update submissions
      set status = ?,
        reviewed_at = ?
      where id = ?
        and status = ?`,
  });

  if (result.rowsAffected === 0) {
    throw new ApiError("invalid_status", "Only pending submissions can be reviewed", 409);
  }
}

function rowToSubmission(row: SubmissionRow): Submission {
  return {
    album: row.album ?? undefined,
    artists: parseArtistsJson(row.artists_json),
    artworkUrl: row.artwork_url ?? undefined,
    contact: row.contact ?? undefined,
    createdAt: row.created_at,
    id: row.id,
    note: row.note ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    source: row.source,
    spotifyTrackId: row.spotify_track_id,
    spotifyUrl: row.spotify_url,
    status: row.status,
    title: row.title,
    triageVerdict: row.triage_verdict ?? undefined,
  };
}

export function hashSubmitter(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim();
  const userAgent = request.headers.get("user-agent")?.slice(0, 120) ?? "unknown";
  const key = `${connectingIp ?? forwardedFor ?? "unknown"}:${userAgent}`;

  return createHash("sha256").update(key).digest("hex");
}

async function notifyDiscord(submission: Submission): Promise<void> {
  const webhookUrl = await readOptionalEnv("DISCORD_WEBHOOK_URL");

  if (!webhookUrl) {
    return;
  }

  const contact = submission.contact ?? "unknown";
  const note = submission.note ?? "none";
  const content = `New Fluncle submission

${submission.artists.join(", ")} - ${submission.title}
Source: ${submission.source}
Submitted by: ${contact}
Note: ${note}

Spotify: ${submission.spotifyUrl}`;

  const response = await fetch(webhookUrl, {
    body: JSON.stringify({
      allowed_mentions: {
        parse: [],
      },
      content,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const message = await response.text();

    throw new Error(`Discord webhook failed: ${response.status} ${message}`);
  }
}
