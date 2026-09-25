import { type InValue } from "@libsql/client/web";
import { createHash, randomUUID } from "node:crypto";
import { getDb, typedRow, typedRows } from "./db";
import {
  type FrontierEditionTrackInput,
  frontierEditionInsertStatements,
} from "./frontier-editions";
import { logEvent } from "./log";
import { type PublicUser } from "./public-auth";
import { listRecommendations } from "./recommendations";
import { getSetting, setSetting } from "./settings";
import { getSpotifyAccessToken, spotifyFetch } from "./spotify";
import { isSpotifyCallBudgetAvailable, recordSpotifyCall } from "./spotify-budget";

export const FRONTIER_MINTING_KEY = "frontier.minting";

export const FRONTIER_PLAYLIST_NAME = "Fluncle's Frontier";

export const FRONTIER_DAILY_MINT_CAP = 20;

const MINT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const FRONTIER_MINT_RATE_LIMIT = 4;

export const FRONTIER_REFRESH_BATCH = 5;

export const FRONTIER_REFRESH_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;

export function frontierPlaylistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

export function frontierDescription(user: PublicUser): string {
  const handle = user.username ?? user.displayUsername;
  const dugFor = handle ? `@${handle}` : "the crew";

  return `Dug for ${dugFor} from the archive. Fresh bangers every week. fluncle.com`;
}

type FrontierRow = {
  cover_uploaded_at: null | string;
  created_at: string;
  last_synced_at: null | string;
  last_uri_hash: null | string;
  playlist_id: string;
  user_id: string;
};

export async function isFrontierMintingOpen(): Promise<boolean> {
  return (await getSetting(FRONTIER_MINTING_KEY)) === "true";
}

export async function setFrontierMintingOpen(open: boolean): Promise<void> {
  await setSetting(FRONTIER_MINTING_KEY, open ? "true" : "false");
}

export async function getFrontierRow(userId: string): Promise<FrontierRow | undefined> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId],
    sql: `select user_id, playlist_id, created_at, last_synced_at, last_uri_hash, cover_uploaded_at
      from user_frontier_playlists where user_id = ? limit 1`,
  });

  return typedRow<FrontierRow>(result.rows);
}

async function countRecentMints(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - MINT_WINDOW_MS).toISOString();
  const result = await (
    await getDb()
  ).execute({
    args: [cutoff],
    sql: `select count(*) as mints from user_frontier_playlists where created_at >= ?`,
  });

  return Number(typedRow<{ mints: number }>(result.rows)?.mints ?? 0);
}

type SqlStatement = { args: InValue[]; sql: string };

type DesiredUris =
  | {
      ok: true;
      seedsSkipped: string[];
      seedsUsed: number;
      tracks: FrontierEditionTrackInput[];
      uris: string[];
    }
  | { ok: false; reason: string };

async function desiredUrisFor(user: PublicUser): Promise<DesiredUris> {
  const recs = await listRecommendations(user, { excludeRecent: true });

  if (recs instanceof Response) {
    return { ok: false, reason: "recommendations_unavailable" };
  }

  const ordered: Array<{ track: FrontierEditionTrackInput; uri: string }> = [];

  for (const finding of recs.findings) {
    if (!finding.spotifyUri) {
      continue;
    }

    ordered.push({
      track: {
        artists: finding.artists,
        bpm: finding.bpm,
        durationMs: finding.durationMs,
        imageUrl: finding.imageUrl,
        key: finding.key,
        logId: finding.logId,
        position: 0,
        similarity: finding.similarity,
        slot: "finding",
        spotifyUri: finding.spotifyUri,
        spotifyUrl: finding.spotifyUrl,
        title: finding.title,
        trackId: finding.trackId,
      },
      uri: finding.spotifyUri,
    });
  }

  for (const track of recs.catalogue) {
    if (!track.spotifyUri) {
      continue;
    }

    ordered.push({
      track: {
        artists: track.artists,
        bpm: track.bpm,
        durationMs: track.durationMs,
        imageUrl: track.imageUrl,
        key: track.key,
        position: 0,
        similarity: track.similarity,
        slot: "catalogue",
        spotifyUri: track.spotifyUri,
        spotifyUrl: track.spotifyUrl,
        title: track.title,
        trackId: track.trackId,
      },
      uri: track.spotifyUri,
    });
  }

  const seen = new Set<string>();
  const uris: string[] = [];
  const tracks: FrontierEditionTrackInput[] = [];

  for (const entry of ordered) {
    if (seen.has(entry.uri)) {
      continue;
    }

    seen.add(entry.uri);
    uris.push(entry.uri);
    tracks.push({ ...entry.track, position: tracks.length + 1 });
  }

  return { ok: true, seedsSkipped: recs.seedsSkipped, seedsUsed: recs.seedsUsed, tracks, uris };
}

async function writeFrontierEdition(statements: SqlStatement[], userId: string): Promise<void> {
  try {
    await (await getDb()).batch(statements, "write");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/unique constraint failed:\s*frontier_editions/i.test(message)) {
      logEvent("warn", "frontier.edition-number-collision", { error, userId });
    }

    throw error;
  }
}

function hashUris(uris: string[]): string {
  return createHash("sha256").update(uris.join(",")).digest("hex");
}

async function latestEditionUriHash(userId: string): Promise<string | undefined> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId, userId],
    sql: `select fet.spotify_uri
      from frontier_edition_tracks fet
      join frontier_editions fe on fe.id = fet.edition_id
      where fe.user_id = ?
        and fe.number = (select max(number) from frontier_editions where user_id = ?)
      order by fet.position asc`,
  });
  const rows = typedRows<{ spotify_uri: null | string }>(result.rows);

  if (rows.length === 0) {
    const exists = await (
      await getDb()
    ).execute({
      args: [userId],
      sql: `select 1 from frontier_editions where user_id = ? limit 1`,
    });

    if (exists.rows.length === 0) {
      return undefined;
    }
  }

  return hashUris(rows.map((row) => row.spotify_uri ?? ""));
}

async function step<T>(name: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type FrontierSyncStatus = "building" | "edition_only" | "minted" | "refreshed" | "unchanged";

export type FrontierSyncResult =
  | { ok: true; playlistId?: string; playlistUrl?: string; status: FrontierSyncStatus }
  | { ok: false; reason: string };

type ComputeResult =
  | {
      editionWritten: boolean;
      hash: string;
      ok: true;
      tracks: FrontierEditionTrackInput[];
      uris: string[];
    }
  | { ok: false; reason: string };

async function computeAndStoreEdition(user: PublicUser, nowMs: number): Promise<ComputeResult> {
  const desired = await desiredUrisFor(user);

  if (!desired.ok) {
    return { ok: false, reason: desired.reason };
  }

  const hash = hashUris(desired.uris);
  const latestHash = await latestEditionUriHash(user.id);

  if (latestHash === hash) {
    return { editionWritten: false, hash, ok: true, tracks: desired.tracks, uris: desired.uris };
  }

  await writeFrontierEdition(
    frontierEditionInsertStatements({
      createdAt: new Date(nowMs).toISOString(),
      editionId: randomUUID(),
      seedsSkipped: desired.seedsSkipped,
      seedsUsed: desired.seedsUsed,
      tracks: desired.tracks,
      userId: user.id,
    }),
    user.id,
  );

  return { editionWritten: true, hash, ok: true, tracks: desired.tracks, uris: desired.uris };
}

async function stampFrontierRefreshed(userId: string, nowMs: number): Promise<void> {
  try {
    await (
      await getDb()
    ).execute({
      args: [userId, new Date(nowMs).toISOString()],
      sql: `insert into user_frontier_refresh (user_id, refreshed_at) values (?, ?)
        on conflict(user_id) do update set refreshed_at = excluded.refreshed_at`,
    });
  } catch (error) {
    logEvent("warn", "frontier.stamp-failed", { error, userId });
  }
}

async function syncFrontier(user: PublicUser, nowMs: number): Promise<FrontierSyncResult> {
  const [compute, mintingOpen, existing] = await Promise.all([
    computeAndStoreEdition(user, nowMs),
    isFrontierMintingOpen(),
    getFrontierRow(user.id),
  ]);

  if (!compute.ok) {
    return { ok: false, reason: compute.reason };
  }

  if (!mintingOpen) {
    return { ok: true, status: compute.editionWritten ? "edition_only" : "unchanged" };
  }

  const description = frontierDescription(user);

  if (existing && existing.last_uri_hash === compute.hash) {
    return {
      ok: true,
      playlistId: existing.playlist_id,
      playlistUrl: frontierPlaylistUrl(existing.playlist_id),
      status: "unchanged",
    };
  }

  if (!(await isSpotifyCallBudgetAvailable(nowMs))) {
    return existing
      ? {
          ok: true,
          playlistId: existing.playlist_id,
          playlistUrl: frontierPlaylistUrl(existing.playlist_id),
          status: "building",
        }
      : { ok: true, status: "building" };
  }

  if (!existing) {
    const [accessToken, mints] = await Promise.all([
      getSpotifyAccessToken(),
      countRecentMints(nowMs),
    ]);

    if (mints >= FRONTIER_DAILY_MINT_CAP) {
      return { ok: false, reason: "mint_cap_reached" };
    }

    const created = (await (
      await step(
        "create",
        spotifyFetch("/me/playlists", accessToken, {
          body: JSON.stringify({ description, name: FRONTIER_PLAYLIST_NAME, public: true }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      )
    ).json()) as { id: string };
    await recordSpotifyCall(nowMs);

    await step(
      "replace",
      spotifyFetch(`/playlists/${created.id}/items`, accessToken, {
        body: JSON.stringify({ uris: compute.uris }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );
    await recordSpotifyCall(nowMs);

    const nowIso = new Date(nowMs).toISOString();

    await (
      await getDb()
    ).execute({
      args: [user.id, created.id, nowIso, nowIso, compute.hash],
      sql: `insert into user_frontier_playlists
            (user_id, playlist_id, created_at, last_synced_at, last_uri_hash, cover_uploaded_at)
          values (?, ?, ?, ?, ?, null)`,
    });

    logEvent("info", "frontier.playlist-minted", { playlistId: created.id, userId: user.id });

    return {
      ok: true,
      playlistId: created.id,
      playlistUrl: frontierPlaylistUrl(created.id),
      status: "minted",
    };
  }

  const accessToken = await getSpotifyAccessToken();
  const playlistId = existing.playlist_id;

  await step(
    "details",
    spotifyFetch(`/playlists/${playlistId}`, accessToken, {
      body: JSON.stringify({ description }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
  );
  await recordSpotifyCall(nowMs);

  await step(
    "replace",
    spotifyFetch(`/playlists/${playlistId}/items`, accessToken, {
      body: JSON.stringify({ uris: compute.uris }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
  );
  await recordSpotifyCall(nowMs);

  const nowIso = new Date(nowMs).toISOString();

  await (
    await getDb()
  ).execute({
    args: [nowIso, compute.hash, user.id],
    sql: `update user_frontier_playlists set last_synced_at = ?, last_uri_hash = ? where user_id = ?`,
  });

  return {
    ok: true,
    playlistId,
    playlistUrl: frontierPlaylistUrl(playlistId),
    status: "refreshed",
  };
}

export async function mintOrRefreshFrontierPlaylist(
  user: PublicUser,
  nowMs: number = Date.now(),
): Promise<FrontierSyncResult> {
  try {
    const result = await syncFrontier(user, nowMs);

    if (result.ok && result.status !== "building") {
      await stampFrontierRefreshed(user.id, nowMs);
    }

    return result;
  } catch (error) {
    logEvent("warn", "frontier.sync-failed", { error, userId: user.id });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  }
}

export type FrontierState = {
  lastSyncedAt?: string;
  mintingOpen: boolean;
  ok: true;
  playlistUrl?: string;
};

export async function getFrontierState(user: PublicUser): Promise<FrontierState> {
  const [row, mintingOpen] = await Promise.all([getFrontierRow(user.id), isFrontierMintingOpen()]);

  return {
    lastSyncedAt: row?.last_synced_at ?? undefined,
    mintingOpen,
    ok: true,
    playlistUrl: row ? frontierPlaylistUrl(row.playlist_id) : undefined,
  };
}

export type FrontierRefreshCounts = {
  budgetPaused: boolean;

  building: number;
  editionOnly: number;
  failed: number;
  minted: number;
  ok: true;
  refreshed: number;
  skipped: number;
  switchOff: boolean;
  total: number;
  unchanged: number;
};

export async function refreshAllFrontierPlaylists(
  limit: number,
  nowMs: number = Date.now(),
): Promise<FrontierRefreshCounts> {
  const mintingOpen = await isFrontierMintingOpen();
  const counts: FrontierRefreshCounts = {
    budgetPaused: false,
    building: 0,
    editionOnly: 0,
    failed: 0,
    minted: 0,
    ok: true,
    refreshed: 0,
    skipped: 0,

    switchOff: !mintingOpen,
    total: 0,
    unchanged: 0,
  };

  const rows = await listDueFrontierUsers(limit, nowMs);
  counts.total = rows.length;

  for (const row of rows) {
    if (mintingOpen && !(await isSpotifyCallBudgetAvailable(nowMs))) {
      counts.budgetPaused = true;
      break;
    }

    const result = await mintOrRefreshFrontierPlaylist(row.user, nowMs);

    if (!result.ok) {
      counts.failed += 1;
      continue;
    }

    if (result.status === "building") {
      counts.building += 1;
      counts.budgetPaused = true;
      break;
    }

    if (result.status === "minted") {
      counts.minted += 1;
    } else if (result.status === "refreshed") {
      counts.refreshed += 1;
    } else if (result.status === "edition_only") {
      counts.editionOnly += 1;
    } else if (result.status === "unchanged") {
      counts.unchanged += 1;
    } else {
      counts.skipped += 1;
    }
  }

  return counts;
}

async function listDueFrontierUsers(
  limit: number,
  nowMs: number,
): Promise<Array<{ user: PublicUser }>> {
  const dueBefore = new Date(nowMs - FRONTIER_REFRESH_MIN_AGE_MS).toISOString();
  const result = await (
    await getDb()
  ).execute({
    args: [dueBefore, limit],
    sql: `select u.id, u.username, u.display_username, u.name, u.image, u.email,
        u.email_verified, u.created_at, u.crew_number
      from (
        select user_id, min(committed_at) as committed_at
        from (
          select fe.user_id as user_id, fe.created_at as committed_at from frontier_editions fe
          union all
          select f.user_id as user_id, f.created_at as committed_at from user_frontier_playlists f
        )
        group by user_id
      ) e
      join "user" u on u.id = e.user_id
      left join user_frontier_playlists p on p.user_id = e.user_id
      left join user_frontier_refresh r on r.user_id = e.user_id
      where u.status = 'active'
        and (r.refreshed_at is null or r.refreshed_at < ?)
      order by (p.user_id is null) desc, coalesce(r.refreshed_at, e.committed_at) asc
      limit ?`,
  });

  type Row = {
    created_at: number;
    crew_number: null | number;
    display_username: null | string;
    email: null | string;
    email_verified: number;
    id: string;
    image: null | string;
    name: null | string;
    username: null | string;
  };

  return typedRows<Row>(result.rows).map((row) => ({
    user: {
      createdAt: new Date(row.created_at).toISOString(),
      crewNumber: row.crew_number ?? undefined,
      displayUsername: row.display_username ?? undefined,
      email: row.email ?? "",
      emailVerified: row.email_verified === 1,
      id: row.id,
      image: row.image ?? undefined,
      name: row.name ?? "",
      username: row.username ?? undefined,
    },
  }));
}

export type FrontierCoverUpload = { uploaded: true } | { uploaded: false; reason: string };

export async function putFrontierCover(
  userId: string,
  playlistId: string,
  jpegBase64: string,
  nowMs: number = Date.now(),
): Promise<FrontierCoverUpload> {
  try {
    const accessToken = await getSpotifyAccessToken();
    const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/images`, {
      body: jpegBase64,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "image/jpeg",
      },
      method: "PUT",
    });

    await recordSpotifyCall(nowMs);

    if (response.status === 401 || response.status === 403) {
      logEvent("info", "frontier.cover-missing-scope", { playlistId, status: response.status });

      return { reason: "missing_scope", uploaded: false };
    }

    if (!response.ok) {
      const body = await response.text();

      return { reason: `spotify_${response.status}: ${body.slice(0, 120)}`, uploaded: false };
    }

    await (
      await getDb()
    ).execute({
      args: [new Date(nowMs).toISOString(), userId],
      sql: `update user_frontier_playlists set cover_uploaded_at = ? where user_id = ?`,
    });

    logEvent("info", "frontier.cover-uploaded", { playlistId, userId });

    return { uploaded: true };
  } catch (error) {
    logEvent("warn", "frontier.cover-upload-failed", { error, playlistId });

    return { reason: error instanceof Error ? error.message : "unknown", uploaded: false };
  }
}

export type FrontierCoverTarget = {
  crewNumber: null | number;
  handle: null | string;
  playlistId: string;
  userId: string;
};

export async function listFrontierCoverTargets(limit: number): Promise<FrontierCoverTarget[]> {
  const result = await (
    await getDb()
  ).execute({
    args: [limit],
    sql: `select f.user_id, f.playlist_id, u.crew_number,
        coalesce(u.display_username, u.username) as handle
      from user_frontier_playlists f
      join "user" u on u.id = f.user_id
      where f.cover_uploaded_at is null and u.status = 'active'
      order by f.created_at asc
      limit ?`,
  });

  type Row = {
    crew_number: null | number;
    handle: null | string;
    playlist_id: string;
    user_id: string;
  };

  return typedRows<Row>(result.rows).map((row) => ({
    crewNumber: row.crew_number,
    handle: row.handle,
    playlistId: row.playlist_id,
    userId: row.user_id,
  }));
}
