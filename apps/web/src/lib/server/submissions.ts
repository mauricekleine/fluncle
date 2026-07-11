import { type Submission, type SubmissionSource, type SubmissionStatus } from "@fluncle/contracts";
import { type SubmissionBody } from "@fluncle/contracts/orpc";

export type { Submission };

import { createHash, randomUUID } from "node:crypto";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { logEvent } from "./log";
import { getPublicSession } from "./public-auth";
import { assertRateLimit } from "./rate-limit";
import { ApiError, fetchTrackMetadata, parseSpotifyTrackUrl } from "./spotify";

const noteMaxLength = 500;
const contactMaxLength = 120;
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxSubmissions = 5;

// The triage verdict is a single operator-internal one-liner (advisory, never
// public), so its bounds are looser than the public `note` gate: floor it above a
// bare word, cap it at a one-line budget. No banned-word/geography scan — it never
// reaches a public surface.
const triageVerdictMinLength = 4;
const triageVerdictMaxLength = 200;

// The submission body is the contract's inferred input (`@fluncle/contracts/orpc`),
// the single source of truth — no parallel hand-mirror to drift. LOOSE/all-unknown
// by design; `validateSubmissionInput` narrows it.
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

  // The shared atomic limiter, keyed on the signed-in user when present else
  // hash(cf-connecting-ip). Rotating the User-Agent (the old `${ip}:${ua}` key)
  // no longer buys a fresh allowance, and the count-then-insert race is gone.
  await assertRateLimit({
    action: "submit_track",
    limit: rateLimitMaxSubmissions,
    message: "Too many submissions from this connection. Try again later.",
    request,
    userId: publicUser?.id,
    windowMs: rateLimitWindowMs,
  });

  const track = await fetchTrackMetadata(input.spotifyTrackId);
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

/**
 * Validate the pre-chew triage verdict — a short operator-internal one-liner. Trims
 * and length-bounds it, throwing a clean `ApiError` (the handler turns it into a
 * 4xx). Advisory only: it never reaches a public surface, so there is no voice gate.
 */
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

/**
 * Write the pre-chew triage verdict onto a PENDING submission (the agent-tier sweep's
 * advisory legwork). Gates the verdict, then updates only while the submission is still
 * pending — a reviewed (approved/rejected) submission is a 409, so a late sweep tick can
 * never re-annotate a decided candidate. Advisory only: this moves no approve/reject
 * authority. Unlike the auto-note's fill-empty-only guard, the sweep MAY refresh its own
 * prior verdict (it re-reads the archive each tick), so a re-triage overwrites.
 */
export async function triageSubmission(id: string, verdict: unknown): Promise<Submission> {
  const gated = gateTriageVerdict(verdict);
  const submission = await getSubmission(id);

  if (submission.status !== "pending") {
    throw new ApiError("invalid_status", "Only pending submissions can be triaged", 409);
  }

  const db = await getDb();
  const result = await db.execute({
    args: [gated, id, "pending"],
    sql: `update submissions
      set triage_verdict = ?
      where id = ?
        and status = ?`,
  });

  if (result.rowsAffected === 0) {
    throw new ApiError("invalid_status", "Only pending submissions can be triaged", 409);
  }

  return getSubmission(id);
}

export function validateSubmissionInput(
  body: SubmissionInput,
): Omit<Submission, "id" | "status" | "createdAt"> {
  if (typeof body.honeypot === "string" && body.honeypot.trim()) {
    throw new ApiError("invalid_request", "Invalid submission", 400);
  }

  const spotifyTrackId = requireText(body.spotifyTrackId, "Missing selected track id");
  const spotifyUrl = requireText(body.spotifyUrl, "Missing selected Spotify URL");
  requireText(body.title, "Missing selected track title");
  parseArtists(body.artists);
  const source = parseSource(body.source);
  optionalText(body.album, 160);
  optionalText(body.artworkUrl, 600);
  const note = optionalText(body.note, noteMaxLength);
  const contact = optionalText(body.contact, contactMaxLength);

  if (!/^[A-Za-z0-9]{22}$/.test(spotifyTrackId)) {
    throw new ApiError("invalid_request", "Invalid selected track id", 400);
  }

  const urlTrackId = parseSpotifyTrackUrl(spotifyUrl);

  if (urlTrackId !== spotifyTrackId) {
    throw new ApiError("invalid_request", "Selected track id does not match Spotify URL", 400);
  }

  return {
    artists: [],
    contact,
    note,
    reviewedAt: undefined,
    source,
    spotifyTrackId,
    spotifyUrl,
    title: "",
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

function parseArtists(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError("invalid_request", "Missing selected track artists", 400);
  }

  const artists = value
    .flatMap((artist) => {
      if (typeof artist !== "string") {
        return [];
      }

      const trimmed = artist.trim();
      return trimmed ? [trimmed] : [];
    })
    .slice(0, 12);

  if (artists.length === 0) {
    throw new ApiError("invalid_request", "Missing selected track artists", 400);
  }

  return artists;
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
