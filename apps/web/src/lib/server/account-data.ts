import { randomUUID } from "node:crypto";
import { type InValue } from "@libsql/client/web";
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
import { getDb, typedRow, typedRows } from "./db";
import { isGalaxyMapFullyNamed } from "./galaxies-map";
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

/**
 * One saved `/mix` set as the list returns it (`listSavedSets`). `setTokens` is the
 * serialized `?set=` chain and `taste` the serialized `?taste=` seed — stored and
 * echoed verbatim, so the account page opens a set by handing them straight back to
 * `/mix`'s loader, no new hydration path.
 */
export type SavedSetItem = {
  createdAt: string;
  id: string;
  name: string;
  setTokens: string;
  taste?: string;
  updatedAt: string;
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

/**
 * The signed-in user's Galaxy collection as a browsable object (the read sibling
 * of `collectLogId`): every collected row enriched through the certification join
 * (title, artists, cover, galaxy), plus the per-NAMED-galaxy completion lines.
 * The galaxy name/slug follow the DTO's omission rule — present only once the
 * operator has named the galaxy; an unnamed or unassigned finding reaches the
 * client without one and renders unheaded (never introduced, no coined noun).
 * The WHOLE galaxy layer sits behind `isGalaxyMapFullyNamed()` — the same gate
 * every galaxy-naming surface uses — so a half-named map never leaks: until the
 * map ships, the read returns a flat collection (no names, no completion lines).
 * Retired galaxies are excluded everywhere (`retired_at is null`, the
 * galaxies-map precedent); a finding in a retired galaxy simply loses its
 * clause. Ordered oldest-first: the collection reads as the user's own log, and
 * their first star stays line one.
 */
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
      join (findings join tracks on tracks.track_id = findings.track_id) t on t.track_id = s.track_id
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

// The most characters a saved set's name carries (the user renames it on /account).
const MAX_SET_NAME = 120;

/**
 * Derive a default name for a set the user saved without one — "the first track ·
 * the date". Resolves the first token's title against the archive (certified by Log
 * ID, or an uncertified catalogue row by track id); a token we've never seen (a raw
 * Spotify id) leaves the plain fallback. Cheap single-row lookup, only on save.
 */
async function defaultSetName(tokens: string[]): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const first = tokens[0];

  if (first) {
    const result = await (
      await getDb()
    ).execute({
      args: [first, first],
      sql: `select tracks.title from tracks
        left join findings on findings.track_id = tracks.track_id
        where tracks.track_id = ? or findings.log_id = ? limit 1`,
    });
    const title = typedRow<SetTitleRow>(result.rows)?.title;

    if (title) {
      return `${title} · ${date}`.slice(0, MAX_SET_NAME);
    }
  }

  return `A set · ${date}`;
}

/** A user-supplied name, trimmed + capped, or the derived default when it's blank. */
async function resolveSetName(raw: unknown, tokens: string[]): Promise<string> {
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  return trimmed ? trimmed.slice(0, MAX_SET_NAME) : defaultSetName(tokens);
}

/** The signed-in user's saved `/mix` sets, most-recently-touched first. */
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

/**
 * Save a chained set for the user. The body carries the SAME serialized `?set=` +
 * `?taste=` strings the `/mix` route uses; they're re-parsed through the shared
 * codec (junk dropped, capped, order kept) and re-serialized, so what's stored
 * round-trips back through the same loader. An empty chain is a 400 — there's
 * nothing to save yet.
 */
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

/**
 * Rename a saved set and/or overwrite its chain — both scoped to the owner. The
 * row is fetched by `(id, user_id)` first, so another user's set is invisible (a
 * 404, never a silent no-op): that is the ownership guard. A `set` in the body
 * overwrites the chain AND its taste seed together (a chain and the lane it was
 * built in travel as one); a blank `name` keeps the existing one.
 */
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

/** Remove a saved set — scoped to the owner (another user's id is a 404). */
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

// ── User preferences (the cross-device settings store) ────────────────────────
// One row per user holding the whole `UserPreferences` object as JSON. The account
// NEVER gates a feature: every preference also has a device-local home, so this is
// purely the SYNCED copy for a signed-in user. Extensible by construction — a new
// preference is a field on the shared `UserPreferences` schema, no migration.

/**
 * Read a user's stored preferences, tolerant of a missing or corrupt blob. A row
 * that is absent, not JSON, or holds an out-of-range value resolves to an EMPTY
 * object — the read never throws, so a bad blob degrades to "nothing set" (the
 * device/default value wins) rather than a 500. Parsed through the LENIENT
 * `UserPreferencesSchema` (unknown keys stripped), so a blob a newer deploy wrote
 * mid-rollout still yields its known fields.
 */
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
    // Not valid JSON — treat a corrupt blob as empty, never throw on read.
    return {};
  }
}

/** The signed-in user's stored preferences (`{}` when none set or the blob is unreadable). */
export async function getUserPreferences(
  user: PublicUser,
): Promise<{ ok: true; preferences: UserPreferences }> {
  return { ok: true, preferences: await readStoredPreferences(user.id) };
}

/**
 * Merge a partial preferences patch into the user's stored object. The body is the
 * closed `UserPreferencesInputSchema` (`.strict()`, so an unknown key is a 400); a
 * field it carries is written, a field it omits is preserved from the current blob,
 * so preferences update INDEPENDENTLY. Upserts one row per user and echoes the full
 * merged object.
 */
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
    preferences: UserPreferences;
    privacyNotes: string[];
    progress: GalaxyProgressResult;
    savedFindings: SavedFindingItem[];
    savedSets: SavedSetItem[];
    submissions: PrivateSubmissionItem[];
  };
  ok: true;
}> {
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const exportId = randomUUID();
  const [progress, saved, sets, submissions, preferences] = await Promise.all([
    getGalaxyProgress(user),
    listSavedFindings(user),
    listSavedSets(user),
    listUserSubmissions(user),
    getUserPreferences(user),
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
      savedFindings: saved.savedFindings,
      savedSets: sets.savedSets,
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
    preferences: string;
    savedFindings: string;
    savedSets: string;
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
    preferences: "deleted",
    savedFindings: "deleted",
    savedSets: "deleted",
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
      sql: `delete from user_saved_sets where user_id = ?`,
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
      // Push tokens bound to this user (the mobile app). Anonymous rows (the
      // V1 default, user_id NULL) are reaped by the
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
    sql: `select tracks.track_id, findings.log_id from findings join tracks on tracks.track_id = findings.track_id
      where tracks.track_id = ? or findings.log_id = ? limit 1`,
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
