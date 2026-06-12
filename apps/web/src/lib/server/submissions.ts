import { createHash, randomUUID } from "node:crypto";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { ApiError, fetchTrackMetadata, parseSpotifyTrackUrl } from "./spotify";

const noteMaxLength = 500;
const contactMaxLength = 120;
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxSubmissions = 5;

const submissionSources = ["web", "cli", "ssh"] as const;
const submissionStatuses = ["pending", "approved", "rejected"] as const;

type SubmissionSource = (typeof submissionSources)[number];
type SubmissionStatus = (typeof submissionStatuses)[number];

export type SubmissionInput = {
  spotifyTrackId?: unknown;
  spotifyUrl?: unknown;
  title?: unknown;
  artists?: unknown;
  album?: unknown;
  artworkUrl?: unknown;
  note?: unknown;
  contact?: unknown;
  source?: unknown;
  honeypot?: unknown;
};

export type Submission = {
  id: string;
  spotifyTrackId: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  note?: string;
  contact?: string;
  source: SubmissionSource;
  status: SubmissionStatus;
  createdAt: string;
  reviewedAt?: string;
};

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
};

type CountRow = {
  submission_count: number;
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
  const createdAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - rateLimitWindowMs).toISOString();

  const rateResult = await db.execute({
    args: [submitterHash, windowStart],
    sql: `select count(*) as submission_count
      from submissions
      where submitter_hash = ?
        and created_at >= ?`,
  });
  const rateRows = typedRows<CountRow>(rateResult.rows);
  const submissionCount = Number(rateRows[0]?.submission_count ?? 0);

  if (submissionCount >= rateLimitMaxSubmissions) {
    throw new ApiError(
      "rate_limited",
      "Too many submissions from this connection. Try again later.",
      429,
    );
  }

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
        submitter_hash
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  try {
    await notifyDiscord(submission);
  } catch (error) {
    console.warn("Discord submission notification failed", error);
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
        reviewed_at
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
        reviewed_at
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
      from tracks
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

function validateSubmissionInput(
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
    .filter((artist): artist is string => typeof artist === "string")
    .map((artist) => artist.trim())
    .filter(Boolean)
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
