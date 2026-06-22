import { randomUUID } from "node:crypto";
import { type InValue } from "@libsql/client/web";
import { parseArtistsJson } from "./artists";
import { getDb, typedRow, typedRows } from "./db";
import { jsonError } from "./env";
import { enforceRateLimit } from "./rate-limit";

// Re-export the shared limiter from its established import site. `enforceRateLimit`
// moved to `./rate-limit` (the one atomic, cf-connecting-ip-keyed limiter), but
// the account/auth call sites (`orpc/devices.ts`, `routes/api/auth/$.ts`) and the
// `/me` preamble below still reach for it here.
export { enforceRateLimit };
import {
  isAllowedDisplayUsername,
  isAllowedUsername,
  requireJsonMutation,
  requirePublicUser,
  type PublicUser,
} from "./public-auth";

type TrackRefRow = {
  log_id: string | null;
  track_id: string;
};

type GalaxyStateRow = {
  deaths: number;
  last_played_at: string | null;
  updated_at: string;
  wins: number;
};

type LogRow = {
  first_collected_at: string;
  last_collected_at: string;
  log_id: string;
  track_id: string;
};

type SavedRow = {
  artists_json: string;
  log_id: string;
  note: string | null;
  saved_at: string;
  title: string;
  track_id: string;
};

type SubmissionRow = {
  artists_json: string;
  created_at: string;
  id: string;
  note: string | null;
  source: string;
  spotify_url: string;
  status: "approved" | "pending" | "rejected";
  title: string;
};

type ExportRow = {
  completed_at: string | null;
  expires_at: string;
  id: string;
  requested_at: string;
  status: string;
};

type UserEmailRow = {
  email: string | null;
};

type SqlStatement = {
  args: InValue[];
  sql: string;
};

export type MeResponse = {
  ok: true;
  user: null | PublicUser;
};

// The success shapes of the `/me` read/write helpers. These are RETURN-TYPE
// annotations only (no behavior change): TypeScript widens a bare `ok: true`
// sibling of a computed property to `boolean` (and a ternary status to `string`),
// which the oRPC contract outputs (`z.literal(true)`, the status enum) reject.
// Pinning the shapes here keeps the wire body byte-identical AND lets the
// contract stay honest (`ok` literal, status enum), so the handlers can return
// these helpers' results directly. The Zod mirrors live in
// `@fluncle/contracts/orpc` (`GalaxyProgress`, `SavedFinding`, `PrivateSubmission`).

/** The Galaxy-progress body (`getGalaxyProgress`). `ok` pinned `true`. */
export type GalaxyProgressResult = {
  collectedLogIds: string[];
  deaths: number;
  lastPlayedAt?: string;
  ok: true;
  updatedAt?: string;
  wins: number;
};

/** One saved finding as the list returns it (`listSavedFindings`). */
export type SavedFindingItem = {
  artists: string[];
  logId: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

/** One submission as the signed-in user sees it (`listUserSubmissions`). */
export type PrivateSubmissionItem = {
  artists: string[];
  createdAt: string;
  id: string;
  note?: string;
  source: string;
  spotifyUrl: string;
  status: "logged" | "passed_on" | "pending_review";
  title: string;
};

export async function meResponse(request: Request): Promise<MeResponse> {
  const { getPublicSession } = await import("./public-auth");
  const user = await getPublicSession(request);

  return {
    ok: true,
    user: user ?? null,
  };
}

/**
 * The shared `me/` mutation preamble: a signed-in public user, a JSON mutation
 * guard (content-type + origin + CSRF), and a rate-limit check. Returns the
 * user on success or a `Response` (401/415/403/429) for any guard failure —
 * handlers return it directly. `windowMs` defaults to one hour (the common
 * account-write window); pass 24h for the delete/export daily windows.
 */
export async function requireAccountMutation(
  request: Request,
  {
    action,
    limit,
    windowMs = 60 * 60 * 1000,
  }: { action: string; limit: number; windowMs?: number },
): Promise<PublicUser | Response> {
  const user = await requirePublicUser(request);

  if (user instanceof Response) {
    return user;
  }

  const guard = requireJsonMutation(request, user);

  if (guard) {
    return guard;
  }

  const limited = await enforceRateLimit({ action, limit, request, userId: user.id, windowMs });

  if (limited) {
    return limited;
  }

  return user;
}

export async function updatePrivateUsername(
  user: PublicUser,
  body: unknown,
): Promise<Response | { ok: true; user: PublicUser }> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid account settings");
  }

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const displayUsername =
    typeof body.displayUsername === "string" ? body.displayUsername.trim() : username;

  if (!isAllowedUsername(username) || !isAllowedDisplayUsername(displayUsername)) {
    return jsonError(400, "invalid_username", "That username does not fit the flight manifest");
  }

  const db = await getDb();
  const existing = await db.execute({
    args: [username, user.id],
    sql: `select id from "user" where username = ? and id != ? limit 1`,
  });

  if (existing.rows.length > 0) {
    return jsonError(409, "username_taken", "That username is already aboard");
  }

  await db.execute({
    args: [username, displayUsername, Date.now(), user.id],
    sql: `update "user" set username = ?, display_username = ?, updated_at = ? where id = ?`,
  });

  return {
    ok: true,
    user: {
      ...user,
      displayUsername,
      username,
    },
  };
}

export async function getGalaxyProgress(user: PublicUser): Promise<GalaxyProgressResult> {
  await ensureGalaxyState(user.id);
  const db = await getDb();
  const [stateResult, logsResult] = await Promise.all([
    db.execute({
      args: [user.id],
      sql: `select deaths, wins, updated_at, last_played_at
        from user_galaxy_state where user_id = ? limit 1`,
    }),
    db.execute({
      args: [user.id],
      sql: `select track_id, log_id, first_collected_at, last_collected_at
        from user_galaxy_collections where user_id = ?
        order by first_collected_at asc`,
    }),
  ]);
  const state = typedRow<GalaxyStateRow>(stateResult.rows);
  const logs = typedRows<LogRow>(logsResult.rows);

  return {
    collectedLogIds: logs.map((row) => row.log_id),
    deaths: Number(state?.deaths ?? 0),
    lastPlayedAt: state?.last_played_at ?? undefined,
    ok: true,
    updatedAt: state?.updated_at,
    wins: Number(state?.wins ?? 0),
  };
}

export async function mergeGalaxyProgress(
  user: PublicUser,
  body: unknown,
): Promise<GalaxyProgressResult | Response> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid Galaxy progress");
  }

  const logIds = Array.isArray(body.collectedLogIds)
    ? body.collectedLogIds.filter((value): value is string => typeof value === "string")
    : [];
  const deaths = numberDelta(body.deaths);
  const wins = numberDelta(body.wins);

  for (const logId of new Set(logIds)) {
    await collectLogId(user, logId, "web");
  }

  await incrementGalaxyCounters(user.id, { deaths, wins });

  return getGalaxyProgress(user);
}

export async function collectLogId(
  user: PublicUser,
  logId: string,
  sourceSurface: "cli" | "mcp" | "ssh" | "web" = "web",
): Promise<Response | { logId: string; ok: true }> {
  const track = await findTrackByTrackOrLog(logId);

  if (!track?.log_id) {
    return jsonError(404, "log_not_found", "No finding at that coordinate");
  }

  await ensureGalaxyState(user.id);
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute({
    args: [randomUUID(), user.id, track.track_id, track.log_id, now, now, sourceSurface],
    sql: `insert into user_galaxy_collections
      (id, user_id, track_id, log_id, first_collected_at, last_collected_at, source_surface)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, track_id) do update set
        last_collected_at = excluded.last_collected_at,
        log_id = excluded.log_id`,
  });
  await touchGalaxyState(user.id, now);

  return { logId: track.log_id, ok: true };
}

export async function incrementGalaxyCounters(
  userId: string,
  counters: { deaths?: number; wins?: number },
) {
  await ensureGalaxyState(userId);
  const now = new Date().toISOString();

  await (
    await getDb()
  ).execute({
    args: [counters.deaths ?? 0, counters.wins ?? 0, now, now, userId],
    sql: `update user_galaxy_state
      set deaths = deaths + ?,
        wins = wins + ?,
        last_played_at = ?,
        updated_at = ?
      where user_id = ?`,
  });
}

export async function listSavedFindings(
  user: PublicUser,
): Promise<{ ok: true; savedFindings: SavedFindingItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select s.track_id, s.log_id, s.saved_at, s.note, t.title, t.artists_json
      from user_saved_findings s
      join tracks t on t.track_id = s.track_id
      where s.user_id = ?
      order by s.saved_at desc`,
  });

  return {
    ok: true,
    savedFindings: typedRows<SavedRow>(result.rows).map((row) => ({
      artists: parseArtistsJson(row.artists_json),
      logId: row.log_id,
      note: row.note ?? undefined,
      savedAt: row.saved_at,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

export async function saveFinding(
  user: PublicUser,
  body: unknown,
): Promise<
  | Response
  | { ok: true; savedFinding: { logId: string; note?: string; savedAt: string; trackId: string } }
> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid saved finding");
  }

  const id =
    typeof body.trackId === "string"
      ? body.trackId
      : typeof body.logId === "string"
        ? body.logId
        : "";
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const track = await findTrackByTrackOrLog(id);

  if (!track?.log_id) {
    return jsonError(404, "track_not_found", "No finding at that coordinate");
  }

  const now = new Date().toISOString();

  await (
    await getDb()
  ).execute({
    args: [randomUUID(), user.id, track.track_id, track.log_id, now, note],
    sql: `insert into user_saved_findings (id, user_id, track_id, log_id, saved_at, note)
      values (?, ?, ?, ?, ?, ?)
      on conflict(user_id, track_id) do update set
        saved_at = excluded.saved_at,
        log_id = excluded.log_id,
        note = excluded.note`,
  });

  return {
    ok: true,
    savedFinding: {
      logId: track.log_id,
      note: note ?? undefined,
      savedAt: now,
      trackId: track.track_id,
    },
  };
}

export async function deleteSavedFinding(
  user: PublicUser,
  trackIdOrLogId: string,
): Promise<Response | { ok: true }> {
  const track = await findTrackByTrackOrLog(trackIdOrLogId);

  if (!track) {
    return jsonError(404, "track_not_found", "No finding at that coordinate");
  }

  await (
    await getDb()
  ).execute({
    args: [user.id, track.track_id],
    sql: `delete from user_saved_findings where user_id = ? and track_id = ?`,
  });

  return { ok: true };
}

export async function listUserSubmissions(
  user: PublicUser,
): Promise<{ ok: true; submissions: PrivateSubmissionItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select id, title, artists_json, spotify_url, source, status, note, created_at
      from submissions where user_id = ?
      order by created_at desc`,
  });

  return {
    ok: true,
    submissions: typedRows<SubmissionRow>(result.rows).map((row) => ({
      artists: parseArtistsJson(row.artists_json),
      createdAt: row.created_at,
      id: row.id,
      note: row.note ?? undefined,
      source: row.source,
      spotifyUrl: row.spotify_url,
      status:
        row.status === "approved"
          ? "logged"
          : row.status === "rejected"
            ? "passed_on"
            : "pending_review",
      title: row.title,
    })),
  };
}

export async function exportAccountData(user: PublicUser): Promise<{
  export: {
    account: PublicUser;
    generatedAt: string;
    id: string;
    privacyNotes: string[];
    progress: GalaxyProgressResult;
    savedFindings: SavedFindingItem[];
    submissions: PrivateSubmissionItem[];
  };
  ok: true;
}> {
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const exportId = randomUUID();
  const [progress, saved, submissions] = await Promise.all([
    getGalaxyProgress(user),
    listSavedFindings(user),
    listUserSubmissions(user),
  ]);

  await (
    await getDb()
  ).execute({
    args: [exportId, user.id, requestedAt, requestedAt, expiresAt, "completed"],
    sql: `insert into user_data_exports
      (id, user_id, requested_at, completed_at, expires_at, status)
      values (?, ?, ?, ?, ?, ?)`,
  });

  return {
    export: {
      account: user,
      generatedAt: requestedAt,
      id: exportId,
      privacyNotes: [
        "Signed-in submissions are included here and kept as anonymized review history if the account is deleted.",
        "Discord and Loops processor copies may follow their own retention windows.",
      ],
      progress,
      savedFindings: saved.savedFindings,
      submissions: submissions.submissions,
    },
    ok: true,
  };
}

export async function getAccountExport(
  user: PublicUser,
  exportId: string,
): Promise<
  | Response
  | {
      export: {
        completedAt?: string;
        expiresAt: string;
        id: string;
        requestedAt: string;
        status: string;
      };
      ok: true;
    }
> {
  const result = await (
    await getDb()
  ).execute({
    args: [exportId, user.id],
    sql: `select id, requested_at, completed_at, expires_at, status
      from user_data_exports
      where id = ? and user_id = ?
      limit 1`,
  });
  const row = typedRow<ExportRow>(result.rows);

  if (!row) {
    return jsonError(404, "export_not_found", "Export not found");
  }

  return {
    export: {
      completedAt: row.completed_at ?? undefined,
      expiresAt: row.expires_at,
      id: row.id,
      requestedAt: row.requested_at,
      status: row.status,
    },
    ok: true,
  };
}

export async function deleteAccount(user: PublicUser): Promise<{
  ok: true;
  summary: {
    credentials: string;
    galaxyProgress: string;
    savedFindings: string;
    sessions: string;
    submissions: string;
    user: string;
    verifications: string;
  };
}> {
  const db = await getDb();
  const requestedAt = new Date().toISOString();
  const requestId = randomUUID();
  const userResult = await db.execute({
    args: [user.id],
    sql: `select email from "user" where id = ? limit 1`,
  });
  const email = typedRow<UserEmailRow>(userResult.rows)?.email ?? undefined;
  const summary = {
    credentials: "deleted",
    galaxyProgress: "deleted",
    savedFindings: "deleted",
    sessions: "revoked",
    submissions: "anonymized",
    user: "marked_deleted",
    verifications: "deleted",
  };

  await db.batch(
    accountDeletionStatements({
      email,
      requestId,
      requestedAt,
      summary,
      userId: user.id,
    }),
  );

  return { ok: true, summary };
}

export function accountDeletionStatements({
  email,
  requestId,
  requestedAt,
  summary,
  userId,
}: {
  email?: string;
  requestId: string;
  requestedAt: string;
  summary: Record<string, string>;
  userId: string;
}): SqlStatement[] {
  return [
    {
      args: [userId],
      sql: `delete from user_saved_findings where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_galaxy_collections where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_galaxy_state where user_id = ?`,
    },
    {
      // Push tokens bound to this user (the mobile app, docs/rfcs/mobile-app.md
      // §7). Anonymous rows (the V1 default, user_id NULL) are reaped by the
      // last_seen_at staleness policy instead; this clears the linked ones.
      args: [userId],
      sql: `delete from push_tokens where user_id = ?`,
    },
    {
      args: [userId],
      sql: `update submissions set user_id = null where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from session where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from account where user_id = ?`,
    },
    {
      args: [userId, email ?? ""],
      sql: `delete from verification where identifier in (?, ?)`,
    },
    {
      args: [Date.now(), Date.now(), `deleted-${userId}@fluncle.invalid`, userId],
      sql: `update "user"
        set status = 'deleted',
          deleted_at = ?,
          updated_at = ?,
          username = null,
          display_username = null,
          email = ?,
          name = 'Deleted account',
          image = null
        where id = ?`,
    },
    {
      args: [
        requestId,
        userId,
        requestedAt,
        requestedAt,
        "completed",
        "delete",
        JSON.stringify(summary),
      ],
      sql: `insert into user_deletion_requests
        (id, user_id, requested_at, completed_at, status, mode, summary_json)
        values (?, ?, ?, ?, ?, ?, ?)`,
    },
  ];
}

async function ensureGalaxyState(userId: string) {
  const now = new Date().toISOString();

  await (
    await getDb()
  ).execute({
    args: [userId, now, now],
    sql: `insert into user_galaxy_state (user_id, created_at, updated_at)
      values (?, ?, ?)
      on conflict(user_id) do nothing`,
  });
}

async function touchGalaxyState(userId: string, now: string) {
  await (
    await getDb()
  ).execute({
    args: [now, now, userId],
    sql: `update user_galaxy_state
      set last_played_at = ?, updated_at = ?
      where user_id = ?`,
  });
}

async function findTrackByTrackOrLog(trackIdOrLogId: string): Promise<TrackRefRow | undefined> {
  const value = trackIdOrLogId.trim();

  if (!value) {
    return undefined;
  }

  const result = await (
    await getDb()
  ).execute({
    args: [value, value],
    sql: `select track_id, log_id from tracks where track_id = ? or log_id = ? limit 1`,
  });

  return typedRow<TrackRefRow>(result.rows);
}

function numberDelta(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
