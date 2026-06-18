import { randomUUID } from "node:crypto";
import { type InValue } from "@libsql/client/web";
import { getDb, typedRow, typedRows } from "./db";
import { jsonError } from "./env";
import {
  hashRequestPart,
  isAllowedDisplayUsername,
  isAllowedUsername,
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

type CountRow = {
  event_count: number;
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
  user:
    | null
    | (PublicUser & {
        featureFlags: {
          exportDelete: true;
          galaxyProgress: true;
          savedFindings: true;
          signedInSubmissions: true;
        };
      });
};

export async function meResponse(request: Request): Promise<MeResponse> {
  const { getPublicSession } = await import("./public-auth");
  const user = await getPublicSession(request);

  return {
    ok: true,
    user: user
      ? {
          ...user,
          featureFlags: {
            exportDelete: true,
            galaxyProgress: true,
            savedFindings: true,
            signedInSubmissions: true,
          },
        }
      : null,
  };
}

export async function enforceRateLimit({
  action,
  limit,
  request,
  userId,
  windowMs,
}: {
  action: string;
  limit: number;
  request: Request;
  userId?: string;
  windowMs: number;
}): Promise<Response | undefined> {
  const db = await getDb();
  const ipHash = hashRequestPart(
    request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0],
  );
  const userAgentHash = hashRequestPart(request.headers.get("user-agent"));
  const bucket = userId ?? ipHash ?? "unknown";
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  const countResult = await db.execute({
    args: [action, bucket, windowStart],
    sql: `select count(*) as event_count from rate_limit_events
      where action = ? and bucket = ? and created_at >= ?`,
  });
  const count = Number(typedRow<CountRow>(countResult.rows)?.event_count ?? 0);

  if (count >= limit) {
    return jsonError(429, "rate_limited", "Too many requests. Try again later.");
  }

  await db.execute({
    args: [
      randomUUID(),
      action,
      bucket,
      userId ?? null,
      ipHash ?? null,
      userAgentHash ?? null,
      new Date().toISOString(),
    ],
    sql: `insert into rate_limit_events
      (id, action, bucket, user_id, ip_hash, user_agent_hash, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`,
  });

  return undefined;
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

export async function getGalaxyProgress(user: PublicUser) {
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

export async function mergeGalaxyProgress(user: PublicUser, body: unknown) {
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
) {
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

export async function listSavedFindings(user: PublicUser) {
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
      artists: JSON.parse(row.artists_json) as string[],
      logId: row.log_id,
      note: row.note ?? undefined,
      savedAt: row.saved_at,
      title: row.title,
      trackId: row.track_id,
    })),
  };
}

export async function saveFinding(user: PublicUser, body: unknown) {
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

export async function deleteSavedFinding(user: PublicUser, trackIdOrLogId: string) {
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

export async function listUserSubmissions(user: PublicUser) {
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
      artists: JSON.parse(row.artists_json) as string[],
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

export async function exportAccountData(user: PublicUser) {
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

export async function getAccountExport(user: PublicUser, exportId: string) {
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

export async function deleteAccount(user: PublicUser) {
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
