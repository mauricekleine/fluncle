import { randomUUID } from "node:crypto";
import { type InValue } from "@libsql/client/web";
import { type MeResponse } from "@fluncle/contracts";
import {
  type GalaxyCollectionItem,
  type GalaxyCompletion,
  type UserPreferences,
  UserPreferencesInputSchema,
  UserPreferencesSchema,
} from "@fluncle/contracts/orpc";
import { bestAlbumCoverUrl } from "../media";
import { parseSetParam, parseTasteParam, serializeSet, serializeTaste } from "../mix-set";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRow, typedRows } from "./db";

import { type RecSeedItem } from "./recommendations";
import { isGalaxyMapFullyNamed } from "./galaxies-map";
import { jsonError } from "./env";
import { enforceRateLimit } from "./rate-limit";
import { bulkTrackOrLogIdCte, TRACK_OR_LOG_ID_CTE } from "./track-id-resolver";

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
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;

  log_id: string | null;
  note: string | null;
  saved_at: string;
  title: string;
  track_id: string;
};

type SavedSetRow = {
  created_at: string;
  id: string;
  name: string;
  set_tokens: string;
  taste: string | null;
  updated_at: string;
};

type SetTitleRow = {
  title: string;
};

type PreferencesRow = {
  preferences: string;
};

type SubmissionRow = {
  artists_json: string;
  created_at: string;
  id: string;

  log_id: string | null;
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

export type { MeResponse };

export type GalaxyProgressResult = {
  collectedLogIds: string[];
  deaths: number;
  lastPlayedAt?: string;
  ok: true;
  updatedAt?: string;
  wins: number;
};

export type SavedFindingItem = {
  artists: string[];
  imageUrl?: string;
  logId?: string;
  note?: string;
  savedAt: string;
  title: string;
  trackId: string;
};

export type SavedSetItem = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
};

export type WatchItem = {
  createdAt: string;
  entityId: string;
  id: string;
  includeSimilar: boolean;
  kind: "artist" | "label";
  name: string;
  slug: string;
};

export type PrivateSubmissionItem = {
  artists: string[];
  createdAt: string;
  id: string;

  logId?: string;
  note?: string;
  source: string;
  spotifyUrl: string;
  status: "logged" | "passed_on" | "pending_review";
  title: string;
};

export async function meResponse(request: Request): Promise<MeResponse> {
  const { getPublicSession, isGoogleSignInEnabled } = await import("./public-auth");
  const [user, googleEnabled] = await Promise.all([
    getPublicSession(request),
    isGoogleSignInEnabled(),
  ]);

  return {
    googleEnabled,
    ok: true,
    user: user ?? null,
  };
}

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

  const usernameInput = typeof body.username === "string" ? body.username.trim() : "";
  const username = usernameInput.toLowerCase();
  const displayUsername =
    typeof body.displayUsername === "string" && body.displayUsername.trim()
      ? body.displayUsername.trim()
      : usernameInput;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : usernameInput;

  if (!isAllowedUsername(username) || !isAllowedDisplayUsername(displayUsername)) {
    return jsonError(
      400,
      "invalid_username",
      "That username can't be used. 3–24 characters: letters, numbers, underscores.",
    );
  }

  if (name.length > 32) {
    return jsonError(400, "invalid_name", "That name is too long. 32 characters at most.");
  }

  const db = await getDb();
  const existing = await db.execute({
    args: [username, user.id],
    sql: `select id from "user" where username = ? and id != ? limit 1`,
  });

  if (existing.rows.length > 0) {
    return jsonError(409, "username_taken", "That username is already taken.");
  }

  await db.execute({
    args: [username, displayUsername, name, Date.now(), user.id],
    sql: `update "user" set username = ?, display_username = ?, name = ?, updated_at = ? where id = ?`,
  });

  return {
    ok: true,
    user: {
      ...user,
      displayUsername,
      name,
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

export const MAX_GALAXY_MERGE_LOG_IDS = 10_000;

const GALAXY_MERGE_CHUNK = 250;

const COLLECT_LOG_SQL = `insert into user_galaxy_collections
      (id, user_id, track_id, log_id, first_collected_at, last_collected_at, source_surface)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, track_id) do update set
        last_collected_at = excluded.last_collected_at,
        log_id = excluded.log_id`;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }

  return out;
}

export async function mergeGalaxyProgress(
  user: PublicUser,
  body: unknown,
): Promise<GalaxyProgressResult | Response> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid Galaxy progress");
  }

  const logIds = Array.isArray(body.collectedLogIds)
    ? [
        ...new Set(
          body.collectedLogIds
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const deaths = numberDelta(body.deaths);
  const wins = numberDelta(body.wins);

  if (logIds.length > MAX_GALAXY_MERGE_LOG_IDS) {
    return jsonError(
      400,
      "too_many_log_ids",
      `A merge carries at most ${MAX_GALAXY_MERGE_LOG_IDS} coordinates.`,
    );
  }

  await collectLogIds(user, logIds, "web");
  await incrementGalaxyCounters(user.id, { deaths, wins });

  return getGalaxyProgress(user);
}

async function collectLogIds(
  user: PublicUser,
  tokens: readonly string[],
  sourceSurface: "cli" | "mcp" | "ssh" | "web",
): Promise<void> {
  if (tokens.length === 0) {
    return;
  }

  const db = await getDb();

  const resolved = new Map<string, string>();

  for (const chunk of chunked(tokens, GALAXY_MERGE_CHUNK)) {
    const result = await db.execute({
      args: chunk,

      sql: `with ${bulkTrackOrLogIdCte(chunk.length)}
        select track_id, log_id from resolved_tracks`,
    });

    for (const row of typedRows<TrackRefRow>(result.rows)) {
      if (row.log_id) {
        resolved.set(row.track_id, row.log_id);
      }
    }
  }

  if (resolved.size === 0) {
    return;
  }

  await ensureGalaxyState(user.id);

  const now = new Date().toISOString();
  const statements = [...resolved].map(([trackId, logId]) => ({
    args: [randomUUID(), user.id, trackId, logId, now, now, sourceSurface],
    sql: COLLECT_LOG_SQL,
  }));

  for (const chunk of chunked(statements, GALAXY_MERGE_CHUNK)) {
    await db.batch(chunk, "write");
  }

  await touchGalaxyState(user.id, now);
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
    sql: COLLECT_LOG_SQL,
  });
  await touchGalaxyState(user.id, now);

  return { logId: track.log_id, ok: true };
}

type CollectionRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;
  first_collected_at: string;
  galaxy_name: string | null;
  galaxy_slug: string | null;
  log_id: string;
  title: string;
  track_id: string;
};

type GalaxyTotalRow = {
  name: string;
  slug: string;
  total: number;
};

export async function listGalaxyCollection(user: PublicUser): Promise<{
  collection: GalaxyCollectionItem[];
  galaxies: GalaxyCompletion[];
  ok: true;
}> {
  const db = await getDb();
  const [mapReady, collectionResult, totalsResult] = await Promise.all([
    isGalaxyMapFullyNamed(),
    db.execute({
      args: [user.id],
      sql: `select c.track_id, c.log_id, c.first_collected_at,
          t.title, t.artists_json, t.album_image_url,
          (select name from galaxies where galaxies.id = f.galaxy_id and retired_at is null) as galaxy_name,
          (select slug from galaxies where galaxies.id = f.galaxy_id and retired_at is null) as galaxy_slug,
          (select image_key from albums where albums.id = t.album_id) as album_image_key,
          (select image_state from albums where albums.id = t.album_id) as album_image_state,
          (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
        from user_galaxy_collections c
        join findings f on f.track_id = c.track_id
        join tracks t on t.track_id = c.track_id
        where c.user_id = ?
        order by c.first_collected_at asc`,
    }),
    db.execute({
      sql: `select g.name, g.slug, count(*) as total
        from findings f
        join galaxies g on g.id = f.galaxy_id
        where f.log_id is not null and g.name is not null and g.retired_at is null
        group by g.id
        order by g.name asc`,
    }),
  ]);

  const collection = typedRows<CollectionRow>(collectionResult.rows).map((row) => ({
    artists: parseArtistsJson(row.artists_json),
    firstCollectedAt: row.first_collected_at,
    galaxyName: (mapReady ? row.galaxy_name : null) ?? undefined,
    galaxySlug: (mapReady ? row.galaxy_slug : null) ?? undefined,
    imageUrl: bestAlbumCoverUrl({
      imageKey: row.album_image_key,
      imageState: row.album_image_state,
      imageUpdatedAt: row.album_image_updated_at,
      spotifyUrl: row.album_image_url,
    }),
    logId: row.log_id,
    title: row.title,
    trackId: row.track_id,
  }));

  const collectedBySlug = new Map<string, number>();

  for (const item of collection) {
    if (item.galaxySlug) {
      collectedBySlug.set(item.galaxySlug, (collectedBySlug.get(item.galaxySlug) ?? 0) + 1);
    }
  }

  const galaxies = mapReady
    ? typedRows<GalaxyTotalRow>(totalsResult.rows).map((row) => ({
        collected: collectedBySlug.get(row.slug) ?? 0,
        name: row.name,
        slug: row.slug,
        total: Number(row.total),
      }))
    : [];

  return { collection, galaxies, ok: true };
}

async function incrementGalaxyCounters(
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

    sql: `select s.track_id, s.log_id, s.saved_at, s.note, t.title, t.artists_json, t.album_image_url,
        (select image_key from albums where albums.id = t.album_id) as album_image_key,
        (select image_state from albums where albums.id = t.album_id) as album_image_state,
        (select image_updated_at from albums where albums.id = t.album_id) as album_image_updated_at
      from user_saved_findings s
      join tracks t on t.track_id = s.track_id
      where s.user_id = ?
      order by s.saved_at desc`,
  });

  return {
    ok: true,
    savedFindings: typedRows<SavedRow>(result.rows).map((row) => ({
      artists: parseArtistsJson(row.artists_json),
      imageUrl: bestAlbumCoverUrl({
        imageKey: row.album_image_key,
        imageState: row.album_image_state,
        imageUpdatedAt: row.album_image_updated_at,
        spotifyUrl: row.album_image_url,
      }),
      logId: row.log_id ?? undefined,
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
  | { ok: true; savedFinding: { logId?: string; note?: string; savedAt: string; trackId: string } }
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

  if (!track) {
    return jsonError(404, "track_not_found", "No track at that coordinate");
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
      logId: track.log_id ?? undefined,
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

const MAX_SET_NAME = 120;

async function defaultSetName(tokens: string[]): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const first = tokens[0];

  if (first) {
    const result = await (
      await getDb()
    ).execute({
      args: [first, first, first],
      sql: `with ${TRACK_OR_LOG_ID_CTE}
        select tracks.title from resolved_track
        join tracks on tracks.track_id = resolved_track.track_id
        limit 1`,
    });
    const title = typedRow<SetTitleRow>(result.rows)?.title;

    if (title) {
      return `${title} · ${date}`.slice(0, MAX_SET_NAME);
    }
  }

  return `A set · ${date}`;
}

async function resolveSetName(raw: unknown, tokens: string[]): Promise<string> {
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  return trimmed ? trimmed.slice(0, MAX_SET_NAME) : defaultSetName(tokens);
}

export async function listSavedSets(
  user: PublicUser,
): Promise<{ ok: true; savedSets: SavedSetItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select id, name, set_tokens, taste, created_at, updated_at
      from user_saved_sets
      where user_id = ?
      order by updated_at desc`,
  });

  return {
    ok: true,
    savedSets: typedRows<SavedSetRow>(result.rows).map(rowToItem),
  };
}

export async function saveSet(
  user: PublicUser,
  body: unknown,
): Promise<Response | { ok: true; savedSet: SavedSetItem }> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid set");
  }

  const tokens = parseSetParam(typeof body.set === "string" ? body.set : "");

  if (tokens.length === 0) {
    return jsonError(400, "empty_set", "There's no set to save yet");
  }

  const tasteSlugs = parseTasteParam(typeof body.taste === "string" ? body.taste : "");
  const name = await resolveSetName(body.name, tokens);
  const setTokens = serializeSet(tokens);
  const taste = tasteSlugs.length > 0 ? serializeTaste(tasteSlugs) : null;
  const now = new Date().toISOString();
  const id = randomUUID();

  await (
    await getDb()
  ).execute({
    args: [id, user.id, name, setTokens, taste, now, now],
    sql: `insert into user_saved_sets
      (id, user_id, name, set_tokens, taste, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?)`,
  });

  return {
    ok: true,
    savedSet: rowToItem({
      created_at: now,
      id,
      name,
      set_tokens: setTokens,
      taste,
      updated_at: now,
    }),
  };
}

export async function updateSavedSet(
  user: PublicUser,
  id: string,
  body: unknown,
): Promise<Response | { ok: true; savedSet: SavedSetItem }> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid set");
  }

  const existing = await (
    await getDb()
  ).execute({
    args: [id, user.id],
    sql: `select id, name, set_tokens, taste, created_at, updated_at
      from user_saved_sets where id = ? and user_id = ? limit 1`,
  });
  const current = typedRow<SavedSetRow>(existing.rows);

  if (!current) {
    return jsonError(404, "set_not_found", "No set to update");
  }

  let setTokens = current.set_tokens;
  let taste = current.taste;

  if (typeof body.set === "string") {
    const tokens = parseSetParam(body.set);

    if (tokens.length === 0) {
      return jsonError(400, "empty_set", "There's no set to save yet");
    }

    const tasteSlugs = parseTasteParam(typeof body.taste === "string" ? body.taste : "");

    setTokens = serializeSet(tokens);
    taste = tasteSlugs.length > 0 ? serializeTaste(tasteSlugs) : null;
  }

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, MAX_SET_NAME)
      : current.name;
  const now = new Date().toISOString();

  await (
    await getDb()
  ).execute({
    args: [name, setTokens, taste, now, id, user.id],
    sql: `update user_saved_sets
      set name = ?, set_tokens = ?, taste = ?, updated_at = ?
      where id = ? and user_id = ?`,
  });

  return {
    ok: true,
    savedSet: rowToItem({
      created_at: current.created_at,
      id,
      name,
      set_tokens: setTokens,
      taste,
      updated_at: now,
    }),
  };
}

export async function deleteSavedSet(
  user: PublicUser,
  id: string,
): Promise<Response | { ok: true }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id, id],
    sql: `delete from user_saved_sets where user_id = ? and id = ?`,
  });

  if ((result.rowsAffected ?? 0) === 0) {
    return jsonError(404, "set_not_found", "No set to remove");
  }

  return { ok: true };
}

function rowToItem(row: SavedSetRow): SavedSetItem {
  return {
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    setTokens: row.set_tokens,
    taste: row.taste ?? undefined,
    updatedAt: row.updated_at,
  };
}

type WatchRow = {
  created_at: string;
  entity_id: string;
  id: string;
  include_similar: number;
  kind: "artist" | "label";
  name: string | null;
  slug: string | null;
};

const WATCH_KINDS = new Set(["artist", "label"]);

export async function listWatches(user: PublicUser): Promise<{ ok: true; watches: WatchItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],
    sql: `select w.id, w.kind, w.entity_id, w.include_similar, w.created_at,
        coalesce(a.name, l.name) as name,
        coalesce(a.slug, l.slug) as slug
      from user_watches w
      left join artists a on w.kind = 'artist' and a.id = w.entity_id
        and ${listedArtistWhere("a")}
      left join labels l on w.kind = 'label' and l.id = w.entity_id
      where w.user_id = ?
      order by w.created_at desc`,
  });

  return {
    ok: true,
    watches: typedRows<WatchRow>(result.rows)
      .filter((row): row is WatchRow & { name: string; slug: string } =>
        Boolean(row.name && row.slug),
      )
      .map((row) => ({
        createdAt: row.created_at,
        entityId: row.entity_id,
        id: row.id,
        includeSimilar: row.include_similar === 1,
        kind: row.kind,
        name: row.name,
        slug: row.slug,
      })),
  };
}

export async function saveWatch(
  user: PublicUser,
  body: unknown,
): Promise<
  | Response
  | {
      ok: true;
      watch: {
        createdAt: string;
        entityId: string;
        id: string;
        includeSimilar: boolean;
        kind: "artist" | "label";
      };
    }
> {
  if (!isRecord(body)) {
    return jsonError(400, "invalid_request", "Invalid watch");
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";

  if (!WATCH_KINDS.has(kind) || !entityId) {
    return jsonError(400, "invalid_request", "Invalid watch");
  }

  const db = await getDb();

  const table = kind === "artist" ? "artists" : "labels";
  const entity = await db.execute({
    args: [entityId],
    sql: `select id from ${table} where id = ? limit 1`,
  });

  if (entity.rows.length === 0) {
    return jsonError(404, "entity_not_found", "No artist or label at that id");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  await db.execute({
    args: [id, user.id, kind, entityId, now],
    sql: `insert into user_watches (id, user_id, kind, entity_id, include_similar, created_at)
      values (?, ?, ?, ?, 0, ?)
      on conflict(user_id, kind, entity_id) do nothing`,
  });

  const stored = await db.execute({
    args: [user.id, kind, entityId],
    sql: `select id, kind, entity_id, include_similar, created_at
      from user_watches where user_id = ? and kind = ? and entity_id = ? limit 1`,
  });
  const row = typedRow<WatchRow>(stored.rows);

  return {
    ok: true,
    watch: {
      createdAt: row?.created_at ?? now,
      entityId,
      id: row?.id ?? id,
      includeSimilar: (row?.include_similar ?? 0) === 1,
      kind: kind as "artist" | "label",
    },
  };
}

export async function deleteWatch(user: PublicUser, id: string): Promise<Response | { ok: true }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id, id],
    sql: `delete from user_watches where user_id = ? and id = ?`,
  });

  if ((result.rowsAffected ?? 0) === 0) {
    return jsonError(404, "watch_not_found", "No watch to remove");
  }

  return { ok: true };
}

async function readStoredPreferences(userId: string): Promise<UserPreferences> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId],
    sql: `select preferences from user_preferences where user_id = ? limit 1`,
  });
  const row = typedRow<PreferencesRow>(result.rows);

  if (!row) {
    return {};
  }

  try {
    const parsed = UserPreferencesSchema.safeParse(JSON.parse(row.preferences));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function getUserPreferences(
  user: PublicUser,
): Promise<{ ok: true; preferences: UserPreferences }> {
  return { ok: true, preferences: await readStoredPreferences(user.id) };
}

export async function updateUserPreferences(
  user: PublicUser,
  body: unknown,
): Promise<Response | { ok: true; preferences: UserPreferences }> {
  const parsed = UserPreferencesInputSchema.safeParse(body);

  if (!parsed.success) {
    return jsonError(400, "invalid_request", "Invalid preferences");
  }

  const merged: UserPreferences = { ...(await readStoredPreferences(user.id)), ...parsed.data };
  const now = new Date().toISOString();

  await (
    await getDb()
  ).execute({
    args: [user.id, JSON.stringify(merged), now],
    sql: `insert into user_preferences (user_id, preferences, updated_at)
      values (?, ?, ?)
      on conflict(user_id) do update set
        preferences = excluded.preferences,
        updated_at = excluded.updated_at`,
  });

  return { ok: true, preferences: merged };
}

export async function listUserSubmissions(
  user: PublicUser,
): Promise<{ ok: true; submissions: PrivateSubmissionItem[] }> {
  const result = await (
    await getDb()
  ).execute({
    args: [user.id],

    sql: `select s.id, s.title, s.artists_json, s.spotify_url, s.source, s.status, s.note,
        s.created_at, f.log_id
      from submissions s
      left join findings f on f.track_id = s.spotify_track_id
      where s.user_id = ?
      order by s.created_at desc`,
  });

  return {
    ok: true,
    submissions: typedRows<SubmissionRow>(result.rows).map((row) => ({
      artists: parseArtistsJson(row.artists_json),
      createdAt: row.created_at,
      id: row.id,

      logId: row.status === "approved" ? (row.log_id ?? undefined) : undefined,
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
    preferences: UserPreferences;
    privacyNotes: string[];
    progress: GalaxyProgressResult;
    recSeeds: RecSeedItem[];
    savedFindings: SavedFindingItem[];
    savedSets: SavedSetItem[];
    submissions: PrivateSubmissionItem[];
    watches: WatchItem[];
  };
  ok: true;
}> {
  const { listRecSeeds } = await import("./recommendations");
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const exportId = randomUUID();
  const [progress, saved, sets, submissions, preferences, recSeeds, watches] = await Promise.all([
    getGalaxyProgress(user),
    listSavedFindings(user),
    listSavedSets(user),
    listUserSubmissions(user),
    getUserPreferences(user),
    listRecSeeds(user),
    listWatches(user),
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
      preferences: preferences.preferences,
      privacyNotes: [
        "I include your signed-in submissions here, and if you delete your account I keep them as anonymized review history.",
        "Discord and Resend processor copies may follow their own retention windows.",
      ],
      progress,
      recSeeds: recSeeds.seeds,
      savedFindings: saved.savedFindings,
      savedSets: sets.savedSets,
      submissions: submissions.submissions,
      watches: watches.watches,
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
    preferences: string;
    recSeeds: string;
    savedFindings: string;
    savedSets: string;
    sessions: string;
    submissions: string;
    user: string;
    verifications: string;
    watches: string;
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
    preferences: "deleted",
    recSeeds: "deleted",
    savedFindings: "deleted",
    savedSets: "deleted",
    sessions: "revoked",
    submissions: "anonymized",
    user: "marked_deleted",
    verifications: "deleted",
    watches: "deleted",
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
      sql: `delete from user_rec_seeds where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_saved_findings where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from frontier_edition_tracks where edition_id in (select id from frontier_editions where user_id = ?)`,
    },
    {
      args: [userId],
      sql: `delete from frontier_editions where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_frontier_playlists where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_frontier_refresh where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_saved_sets where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_watches where user_id = ?`,
    },
    {
      args: [userId],
      sql: `delete from user_preferences where user_id = ?`,
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
    args: [value, value, value],

    sql: `with ${TRACK_OR_LOG_ID_CTE}
      select tracks.track_id, findings.log_id from resolved_track
      join tracks on tracks.track_id = resolved_track.track_id
      left join findings on findings.track_id = tracks.track_id
      limit 1`,
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
