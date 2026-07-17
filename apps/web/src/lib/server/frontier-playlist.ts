// FLUNCLE'S FRONTIER — a public playlist for every crew member (E2, the public
// recommendation machine; docs/planning/ROADMAP.md § the public recommendation
// machine).
//
// The operator's Telescope (./telescope-playlist.ts) is the model: a Spotify
// playlist that is a pure MIRROR of a ranking, never hand-curated, full-replaced on
// a change and skipped on none. This is that idea generalized to a signed-in
// listener — one PUBLIC playlist per verified user, on FLUNCLE'S OWN Spotify account
// (no per-user OAuth, so the dev-mode 5-user allow-list cap never binds), holding
// THEIR recommendations (the E1 blend: findings slots first, then the catalogue
// recs), refreshed weekly. It is a durable, shareable artifact — a playlist in
// someone's Spotify — that markets the archive every week.
//
// ── SHIPPED DARK. Three brakes, all default-safe ─────────────────────────────
//   1. THE KILL SWITCH (`frontier.minting`, the `settings` KV). DEFAULT-DENY, the
//      exact inversion `capture-budget.ts` / `publish-advance.ts` ship: ONLY the
//      literal string "true" opens minting. An unset key, a fresh deploy, a preview
//      branch, a lost row — every one of them reads as CLOSED. The machine can create
//      a playlist on the operator's Spotify account only because he deliberately wrote
//      "true"; anything that loses that row falls back to doing nothing.
//   2. THE ROLLING DAILY MINT CAP (`FRONTIER_DAILY_MINT_CAP`). A NEW playlist creation
//      is blocked once `created_at >= now-24h` count hits the cap — a rolling window,
//      not a calendar day (a midnight reset is a cliff to game). A REFRESH of an
//      existing playlist is never capped; only fresh creations are.
//   3. THE MIRROR-STATE GUARD. The desired URI list's sha256 is stored per-row
//      (`last_uri_hash`); an unchanged list skips the Spotify PUT entirely, so a
//      weekly refresh that finds nothing new is one read, not a needless write.
//
// ── BEST-EFFORT THROUGHOUT ───────────────────────────────────────────────────
// Every Spotify call is wrapped: a fault returns `{ ok: false, reason }` and never
// throws through. The `/me` mint op and the weekly refresh sweep both ride on that —
// a Spotify hiccup degrades one user's Frontier, it never fails the request or the
// sweep.
//
// ── THE COVER IS A NODE-SIDE LEG (Remotion can't run in the Worker) ──────────
// A custom cover is a per-user Remotion render (the Nostalgic Cosmos base + the crew
// № stamped in a corner). Remotion needs a real headless Chromium — it does NOT run
// in a Cloudflare Worker — so the render CANNOT happen here. The honest split:
//   - the RENDER is a Node-side script (apps/web/scripts/render-frontier-covers.ts,
//     operator/box-run) that produces the JPEG and calls `putFrontierCover`;
//   - `putFrontierCover` (below) is the Worker-importable UPLOAD leg — a plain
//     Spotify `PUT /playlists/{id}/images`, which is just an HTTP call and runs fine
//     in Node or the Worker.
// `mintOrRefreshFrontierPlaylist` therefore does NOT render or upload a cover — it
// leaves the new row's `cover_uploaded_at` NULL, and the cover script's worklist is
// exactly "rows where cover_uploaded_at IS NULL". The upload leg is INERT until the
// operator re-auths with the `ugc-image-upload` scope: every PUT 403s the missing
// scope, is caught, and stamps nothing (`{ uploaded: false, reason: "missing_scope" }`).

import { createHash } from "node:crypto";
import { getDb, typedRow, typedRows } from "./db";
import { logEvent } from "./log";
import { type PublicUser } from "./public-auth";
import { listRecommendations } from "./recommendations";
import { getSetting, setSetting } from "./settings";
import { getSpotifyAccessToken, spotifyFetch } from "./spotify";

/** The kill-switch key on the shared `settings` KV. DEFAULT-DENY (only "true" opens). */
export const FRONTIER_MINTING_KEY = "frontier.minting";

/** The playlist's name — one Frontier for every crew member. */
export const FRONTIER_PLAYLIST_NAME = "Fluncle's Frontier";

/**
 * The rolling-24h cap on NEW playlist creations. A brake against a runaway that would
 * spray playlists across the operator's Spotify account; a refresh of an existing
 * playlist is never counted. 20 is comfortably above any real day of sign-ups while
 * still bounding the blast radius of a bug. It binds only once minting is un-paused;
 * until then the kill switch means it is never reached.
 */
export const FRONTIER_DAILY_MINT_CAP = 20;

/** The mint cap's window. Rolling, not calendar: a midnight reset is a cliff to game. */
const MINT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The `/me/frontier-playlist` mint rate limit — a modest per-user hourly budget. */
export const FRONTIER_MINT_RATE_LIMIT = 4;
export const FRONTIER_MINT_RATE_WINDOW_MS = 60 * 60 * 1000;

/** A minted/refreshed playlist's public web URL. */
export function frontierPlaylistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

/**
 * The personalized description Spotify shows on the playlist. Sentence case, no em
 * dashes, ≤300 chars (the VOICE register for a public surface a stranger's mate texted
 * them a link to). The handle prefers the account's username; a legacy account with
 * none falls back to a plain, un-@'d noun so the line never reads "@".
 */
export function frontierDescription(user: PublicUser): string {
  const handle = user.username ?? user.displayUsername;
  const dugFor = handle ? `@${handle}` : "the crew";

  return `Dug for ${dugFor} from the far side of the archive. Refreshed weekly. fluncle.com`;
}

/** The stored row, one per user. */
type FrontierRow = {
  cover_uploaded_at: null | string;
  created_at: string;
  last_synced_at: null | string;
  last_uri_hash: null | string;
  playlist_id: string;
  user_id: string;
};

/**
 * Whether Frontier minting is OPEN — THE KILL SWITCH.
 *
 * DEFAULT-DENY, the exact inversion `capture-budget.ts` / `publish-advance.ts` ship:
 * only the EXPLICIT string "true" means open. An unset key, an empty database, a fresh
 * deploy, a preview branch, a lost row — every one of them reads as CLOSED. This is
 * what lets the whole feature ship DARK: the machine can create a playlist on the
 * operator's Spotify account only because he deliberately wrote "true" into this row.
 */
export async function isFrontierMintingOpen(): Promise<boolean> {
  return (await getSetting(FRONTIER_MINTING_KEY)) === "true";
}

/** Open / close Frontier minting. One flip, effective on the next mint, no deploy. */
export async function setFrontierMintingOpen(open: boolean): Promise<void> {
  await setSetting(FRONTIER_MINTING_KEY, open ? "true" : "false");
}

/** The user's Frontier row, or undefined when they have no playlist yet. */
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

/**
 * How many NEW playlists were created inside the rolling mint window — the daily-cap
 * ledger. One indexed-enough scan of a small per-user table (there is exactly one row
 * per user who ever minted), counting `created_at` inside the window.
 */
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

/** The desired URI list for a user: findings slots first, then catalogue, de-duped. */
type DesiredUris = { ok: true; uris: string[] } | { ok: false; reason: string };

async function desiredUrisFor(user: PublicUser): Promise<DesiredUris> {
  const recs = await listRecommendations(user);

  // `listRecommendations` returns a `jsonError` Response on an unverified email (the
  // learning-cohort gate). A minted Frontier always belonged to a verified user, but
  // the refresh sweep iterates blind, so treat a Response as "skip, don't crash".
  if (recs instanceof Response) {
    return { ok: false, reason: "recommendations_unavailable" };
  }

  const ordered = [
    ...recs.findings.map((finding) => finding.spotifyUri),
    ...recs.catalogue.map((track) => track.spotifyUri),
  ].filter((uri): uri is string => Boolean(uri));

  // De-dupe preserving order: a finding slot and a catalogue rec could resolve to the
  // same Spotify track, and a playlist must not carry it twice.
  const seen = new Set<string>();
  const uris = ordered.filter((uri) => (seen.has(uri) ? false : (seen.add(uri), true)));

  return { ok: true, uris };
}

/** The sha256 of a URI list — the per-row mirror change-detector. */
function hashUris(uris: string[]): string {
  return createHash("sha256").update(uris.join(",")).digest("hex");
}

/** Names the failing Spotify call in the error, so a 403 says WHICH request it refused. */
async function step<T>(name: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type FrontierSyncStatus = "minted" | "refreshed" | "switch_off" | "unchanged";

export type FrontierSyncResult =
  | { ok: true; playlistId?: string; playlistUrl?: string; status: FrontierSyncStatus }
  | { ok: false; reason: string };

/**
 * Mint or refresh a user's Frontier playlist — the one entry point.
 *
 * The order is the priority:
 *   1. THE KILL SWITCH first. Closed ⇒ `{ ok: true, status: "switch_off" }` with NO
 *      Spotify call — the same shape a caller can surface plainly.
 *   2. Compute the desired URI list (the E1 blend). Empty (no seeds/embeddings yet) is
 *      still a valid list; the playlist simply carries nothing until the user seeds.
 *   3. Mirror guard FIRST for an existing playlist: the desired list's hash matches the
 *      stored one ⇒ return `unchanged` with NO Spotify call at all (not even a token
 *      acquire) — the KV/row hash IS the truth of what the mirror last wrote, so an
 *      unchanged week costs one read (the Telescope's exact discipline).
 *   4. Otherwise acquire the token and either create-once (no row ⇒ mint, bounded by the
 *      daily cap) or full-replace via `PUT /playlists/{id}/items` (the Telescope's proven
 *      endpoint — never the legacy `/tracks` alias). The new hash + `last_synced_at` are
 *      stamped only AFTER the PUT lands, so a failed write retries next time.
 *   5. The description is set at create AND on every CHANGED refresh (bundled with the
 *      item replace), so an edited username or the copy itself propagates without ever
 *      costing a write on an unchanged week.
 *
 * Best-effort: any Spotify fault becomes `{ ok: false, reason }` — never a throw.
 */
export async function mintOrRefreshFrontierPlaylist(
  user: PublicUser,
  nowMs: number = Date.now(),
): Promise<FrontierSyncResult> {
  if (!(await isFrontierMintingOpen())) {
    return { ok: true, status: "switch_off" };
  }

  try {
    const desired = await desiredUrisFor(user);

    if (!desired.ok) {
      return { ok: false, reason: desired.reason };
    }

    const existing = await getFrontierRow(user.id);
    const description = frontierDescription(user);
    const hash = hashUris(desired.uris);

    // ── Mirror guard: an unchanged existing playlist is zero Spotify calls ─────
    if (existing && existing.last_uri_hash === hash) {
      return {
        ok: true,
        playlistId: existing.playlist_id,
        playlistUrl: frontierPlaylistUrl(existing.playlist_id),
        status: "unchanged",
      };
    }

    const accessToken = await getSpotifyAccessToken();

    // ── Create-once ──────────────────────────────────────────────────────────
    if (!existing) {
      const mints = await countRecentMints(nowMs);

      if (mints >= FRONTIER_DAILY_MINT_CAP) {
        return { ok: false, reason: "mint_cap_reached" };
      }

      // `POST /me/playlists` — Spotify's Feb-2026 Web API migration RETIRED the
      // `/users/{id}/playlists` create (bare 403 since 2026-03-09), which also
      // retires the /me id pre-read the old URL needed. Probed live 2026-07-17:
      // /me/playlists returns 201 on the same grant the old endpoint 403s.
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

      await step(
        "replace",
        spotifyFetch(`/playlists/${created.id}/items`, accessToken, {
          body: JSON.stringify({ uris: desired.uris }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        }),
      );

      const nowIso = new Date(nowMs).toISOString();

      await (
        await getDb()
      ).execute({
        args: [user.id, created.id, nowIso, nowIso, hash],
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

    // ── Refresh an existing playlist (the item list changed) ────────────────────
    const playlistId = existing.playlist_id;

    // Re-set the description (bundled with the change, so an unchanged week costs
    // nothing), then full-replace the items.
    await step(
      "details",
      spotifyFetch(`/playlists/${playlistId}`, accessToken, {
        body: JSON.stringify({ description }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );

    await step(
      "replace",
      spotifyFetch(`/playlists/${playlistId}/items`, accessToken, {
        body: JSON.stringify({ uris: desired.uris }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    );

    // Stored only AFTER the PUT landed, so a failed write is retried next refresh.
    await (
      await getDb()
    ).execute({
      args: [new Date(nowMs).toISOString(), hash, user.id],
      sql: `update user_frontier_playlists set last_synced_at = ?, last_uri_hash = ? where user_id = ?`,
    });

    return {
      ok: true,
      playlistId,
      playlistUrl: frontierPlaylistUrl(playlistId),
      status: "refreshed",
    };
  } catch (error) {
    logEvent("warn", "frontier.sync-failed", { error, userId: user.id });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  }
}

/** The `/me` GET read: what the Frontier page shows about a user's playlist. */
export type FrontierState = {
  lastSyncedAt?: string;
  mintingOpen: boolean;
  ok: true;
  playlistUrl?: string;
};

/**
 * A user's Frontier state for the `/me` GET — the playlist URL + when it last synced
 * (both absent until the first mint), plus the kill-switch state so the page can say
 * honestly whether minting is open right now instead of offering a button that 503s.
 */
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
  failed: number;
  minted: number;
  ok: true;
  refreshed: number;
  skipped: number;
  switchOff: boolean;
  total: number;
  unchanged: number;
};

/**
 * Refresh EVERY minted Frontier playlist — the weekly sweep's engine (the
 * `refresh_frontier_playlists` admin op). Respects the kill switch first (a closed
 * switch returns `switchOff: true` and touches nothing), then walks the rows oldest
 * first and mint-or-refreshes each. Best-effort per user: one user's Spotify fault is
 * counted as `failed` and the walk continues.
 *
 * `limit` bounds a tick so the op stays cheap even as the crew grows; the sweep loops
 * until the whole set is walked.
 */
export async function refreshAllFrontierPlaylists(
  limit: number,
  nowMs: number = Date.now(),
): Promise<FrontierRefreshCounts> {
  const counts: FrontierRefreshCounts = {
    failed: 0,
    minted: 0,
    ok: true,
    refreshed: 0,
    skipped: 0,
    switchOff: false,
    total: 0,
    unchanged: 0,
  };

  if (!(await isFrontierMintingOpen())) {
    counts.switchOff = true;

    return counts;
  }

  const rows = await listFrontierUsers(limit);
  counts.total = rows.length;

  for (const row of rows) {
    const result = await mintOrRefreshFrontierPlaylist(row.user, nowMs);

    if (!result.ok) {
      counts.failed += 1;
      continue;
    }

    if (result.status === "minted") {
      // A row that vanished then re-minted mid-walk (rare) — counted honestly.
      counts.minted += 1;
    } else if (result.status === "refreshed") {
      counts.refreshed += 1;
    } else if (result.status === "unchanged") {
      counts.unchanged += 1;
    } else {
      // "switch_off" can only appear if the switch flipped mid-walk — count it as
      // skipped rather than pretending it refreshed.
      counts.skipped += 1;
    }
  }

  return counts;
}

/**
 * The minted-Frontier users the refresh sweep walks, oldest first, hydrated into the
 * `PublicUser` shape the sync needs (the description reads the handle; the recs read
 * the id + verified flag). ONE join, bounded by `limit`.
 */
async function listFrontierUsers(limit: number): Promise<Array<{ user: PublicUser }>> {
  const result = await (
    await getDb()
  ).execute({
    args: [limit],
    sql: `select u.id, u.username, u.display_username, u.name, u.image, u.email,
        u.email_verified, u.created_at, u.crew_number
      from user_frontier_playlists f
      join "user" u on u.id = f.user_id
      where u.status = 'active'
      order by f.created_at asc
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

// ── The cover UPLOAD leg (Node-side render → Worker-importable PUT) ───────────

export type FrontierCoverUpload = { uploaded: true } | { uploaded: false; reason: string };

/**
 * Upload a rendered cover onto a Frontier playlist — `PUT /playlists/{id}/images`.
 *
 * The image arrives as a base64 JPEG (rendered Node-side; Remotion can't run in the
 * Worker), so this leg is just an HTTP PUT and runs anywhere. It is INERT by design
 * until the operator re-auths with the `ugc-image-upload` scope: Spotify answers a
 * 401/403 for the missing scope, which is caught and returned as
 * `{ uploaded: false, reason: "missing_scope" }` — nothing is stamped, so the row
 * stays on the cover worklist and the retry costs nothing. A success stamps
 * `cover_uploaded_at`, taking the row off the worklist.
 *
 * Best-effort: any fault returns `{ uploaded: false, reason }`, never a throw.
 */
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

    // A missing scope is the EXPECTED state until the operator re-auths — a clean,
    // logged degrade, not a fault. Spotify answers 403 (and, for some token states,
    // 401) when the grant lacks `ugc-image-upload`.
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

/**
 * The cover worklist — minted playlists whose cover has not yet landed
 * (`cover_uploaded_at IS NULL`). The Node-side render script (operator/box-run) reads
 * this, renders each cover, and calls `putFrontierCover`. Carries the crew number +
 * handle the render stamps, oldest first.
 */
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
