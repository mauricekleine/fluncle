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

/**
 * How many committed users a single paced-drain tick processes. Deliberately SMALL — the
 * sweep no longer bursts every playlist in one tick (which collided with the shared per-app
 * Spotify budget and 429'd live user paths); it drains a batch, stamps each, and resumes next
 * tick. At a ~15-minute cadence a batch of 5 clears ~480 users/day, so the whole crew refreshes
 * well inside the {@link FRONTIER_REFRESH_MIN_AGE_MS} window — each user still refreshes ~weekly,
 * just spread across the day instead of all at 07:00. The CLI `--limit` overrides for an
 * attended burn.
 */
export const FRONTIER_REFRESH_BATCH = 5;

/**
 * A user is DUE for a paced refresh once their last-processed stamp (`user_frontier_refresh`)
 * is older than this. ~6 days keeps the per-user cadence weekly while letting the drain run
 * every few minutes without reprocessing the same user each tick. A user with NO stamp (never
 * processed, or a pending mint the hot path deferred) is always due, so a fresh mint jumps the
 * queue ahead of the weekly refreshers.
 */
export const FRONTIER_REFRESH_MIN_AGE_MS = 6 * 24 * 60 * 60 * 1000;

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

/** One statement in a `db.batch(...)` — the playlist write folded with the edition inserts. */
type SqlStatement = { args: InValue[]; sql: string };

/**
 * The desired URI list for a user: findings slots first, then catalogue, de-duped. Also
 * carries the surviving rec rows as FROZEN edition-track inputs (A2) — the SAME de-duped
 * order the PUT sends, so the edition snapshot is a byte-faithful record of what shipped —
 * plus the engine's seed accounting (`seedsUsed`/`seedsSkipped`), frozen onto the edition
 * so the shelf's honesty strings survive without re-running the engine on a read.
 */
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
  // `excludeRecent: true` is the FRONTIER NOVELTY switch — it drops every track from the
  // user's last FRONTIER_NOVELTY_WINDOW editions so the weekly playlist rotates. This is
  // the ONLY behaviour change A2 introduces, and it is reached only from the mint/refresh
  // flow, itself gated by the default-deny `frontier.minting` kill switch — so novelty
  // stays dark until the operator opens minting (the switch is untouched here).
  const recs = await listRecommendations(user, { excludeRecent: true });

  // `listRecommendations` returns a `jsonError` Response on an unverified email (the
  // learning-cohort gate). A minted Frontier always belonged to a verified user, but
  // the refresh sweep iterates blind, so treat a Response as "skip, don't crash".
  if (recs instanceof Response) {
    return { ok: false, reason: "recommendations_unavailable" };
  }

  // Findings slots first, then catalogue — the E1 blend order the PUT sends. Each row is
  // carried WHOLE (title/artists/cover/links + the frozen bpm/key/duration readouts), so
  // the snapshot writer freezes exactly the metadata the playlist shipped. A row with no
  // Spotify URI never reaches the playlist, so it is dropped here before the freeze too.
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

  // De-dupe preserving order: a finding slot and a catalogue rec could resolve to the
  // same Spotify track, and a playlist must not carry it twice. The FIRST occurrence wins
  // (a shared track keeps its finding slot), and `position` is the 1-based rank in this
  // surviving order — exactly what the PUT sends and what the snapshot freezes.
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

/**
 * Run the ONE atomic batch that writes a frozen edition — `db.batch(_, "write")` is a real
 * BEGIN…COMMIT that rolls back wholesale on any failure (verified via `setMixtapeMembers`,
 * `mixtapes.ts`), so the parent row + its child tracks commit as one unit. A
 * `UNIQUE(user_id, number)` collision — near-impossible, since the number derives inline via
 * `coalesce(max(number),0)+1` inside this same transaction — is logged DISTINCTLY so the
 * sweep's tally never mistakes it for a Spotify fault; the error still propagates to the
 * caller's best-effort `{ ok: false }` wrapper.
 */
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

/** The sha256 of a URI list — the per-row mirror change-detector. */
function hashUris(uris: string[]): string {
  return createHash("sha256").update(uris.join(",")).digest("hex");
}

/**
 * The URI hash of a user's LATEST edition — the edition change-detector, the INTERNAL twin
 * of the mirror's `last_uri_hash`. It re-derives the hash from the newest edition's frozen
 * child rows (every child carries a `spotify_uri`, since a URI-less rec never reaches the
 * playlist or the freeze), so "identical desired list ⇒ no new edition row" survives even
 * for an edition-only user who has NO playlist row (minted while minting was dark). Returns
 * undefined when the user has no edition yet.
 */
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
    // No edition at all → undefined. (An edition can carry zero tracks — a user with no
    // seeds yet — but then the row above still returns nothing; that degenerate case is
    // indistinguishable from "no edition" here, which is harmless: an empty desired list
    // hashes to a stable value and the mint path writes edition #1 regardless.)
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

/** Names the failing Spotify call in the error, so a 403 says WHICH request it refused. */
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

/**
 * The result of the edition half — the INTERNAL cache write, ALWAYS allowed (D1). Carries
 * whether a new edition was actually written (an identical desired list writes none) and
 * the desired list + hash the mirror half reuses, so the engine runs exactly once.
 */
type ComputeResult =
  | {
      editionWritten: boolean;
      hash: string;
      ok: true;
      tracks: FrontierEditionTrackInput[];
      uris: string[];
    }
  | { ok: false; reason: string };

/**
 * Compute the user's recommendations and STORE them as a frozen edition — the internal
 * cache, decoupled from Spotify minting (RFC D1). ALWAYS allowed: the kill switch gates the
 * EXTERNAL Spotify effect, never this internal write. The identical-desired-list skip
 * survives here as "same as the latest edition ⇒ no new edition row" (`latestEditionUriHash`,
 * the internal twin of the mirror's `last_uri_hash`). The edition is written FIRST — so the
 * shelf's source of truth lands even when Spotify is down — as its own atomic batch (parent
 * + children), with the honesty meta (`seedsUsed`/`seedsSkipped`) and per-row `similarity`
 * frozen in.
 */
async function computeAndStoreEdition(user: PublicUser, nowMs: number): Promise<ComputeResult> {
  const desired = await desiredUrisFor(user);

  if (!desired.ok) {
    return { ok: false, reason: desired.reason };
  }

  const hash = hashUris(desired.uris);
  const latestHash = await latestEditionUriHash(user.id);

  // Identical to the latest edition ⇒ no new edition (the internal hash-skip). The mirror
  // half still runs independently on the desired list (an edition-only user opening minting
  // needs the Spotify create even though the edition is unchanged).
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

/**
 * Stamp WHEN the paced drain last PROCESSED this user (`user_frontier_refresh`) — the cursor
 * the due-query orders and gates by. Upsert, so the row is born on the first processing and
 * advances thereafter. Best-effort: a stamp hiccup logs and is swallowed — it never downgrades
 * an otherwise-successful sync, and a missed stamp only means the next tick re-evaluates the
 * user (idempotent).
 */
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

/**
 * The edition + Spotify mirror, WITHOUT the stamp or the best-effort wrapper — the body
 * {@link mintOrRefreshFrontierPlaylist} wraps. Split out so the wrapper can stamp the drain
 * cursor on a settled non-`building` outcome and swallow a throw once, in one place.
 */
async function syncFrontier(user: PublicUser, nowMs: number): Promise<FrontierSyncResult> {
  // The internal compute (the edition write) and the two mint-DECISION reads (the
  // kill switch + the existing playlist row) are mutually independent — the switch
  // and the row gate only the EXTERNAL Spotify mirror, never the compute — so they run
  // CONCURRENTLY instead of laddering after the ~2 s compute (the tiny reads hide under
  // it). Each is its own libsql `execute`, so the three fire as concurrent subrequests.
  const [compute, mintingOpen, existing] = await Promise.all([
    computeAndStoreEdition(user, nowMs),
    isFrontierMintingOpen(),
    getFrontierRow(user.id),
  ]);

  if (!compute.ok) {
    return { ok: false, reason: compute.reason };
  }

  // ── The EXTERNAL Spotify mirror is the ONLY thing the kill switch gates ─────
  if (!mintingOpen) {
    return { ok: true, status: compute.editionWritten ? "edition_only" : "unchanged" };
  }

  const description = frontierDescription(user);

  // ── Mirror guard: an unchanged existing playlist is zero Spotify calls ─────
  if (existing && existing.last_uri_hash === compute.hash) {
    return {
      ok: true,
      playlistId: existing.playlist_id,
      playlistUrl: frontierPlaylistUrl(existing.playlist_id),
      status: "unchanged",
    };
  }

  // ── The shared per-app Spotify budget gate ─────────────────────────────────
  // Both remaining branches SPEND Spotify writes. Consult the shared meter BEFORE firing:
  // a spent window means DEFER, never burst through — the per-app budget is one bucket every
  // Spotify path draws on, and a live signup's create must not lose the race to a background
  // drain. The edition is already durably written, so deferring costs the user nothing but a
  // short wait: the paced sweep completes the owed write inside a fresh window. `building`
  // carries the existing playlist URL through for a deferred REFRESH (the user keeps their
  // current playlist); a deferred CREATE has none yet (the UI says "on its way").
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

  // ── Create-once ──────────────────────────────────────────────────────────
  if (!existing) {
    // The mint-cap ledger read and the Spotify token fetch are independent — one
    // bounds the create, the other authorizes it — so they run together.
    const [accessToken, mints] = await Promise.all([
      getSpotifyAccessToken(),
      countRecentMints(nowMs),
    ]);

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

    // The playlist row lands AFTER the Spotify PUT (a failed create retries next tick with
    // no orphan row). Decoupled from the edition: the edition is already durably written,
    // so this is a single write, not a batch — the mirror's `last_uri_hash` is its own
    // idempotence, independent of the edition's.
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

  // ── Refresh an existing playlist (the item list changed) ────────────────────
  const accessToken = await getSpotifyAccessToken();
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

  // The mirror's `last_uri_hash` advances only AFTER the PUT landed, so a failed write
  // retries next refresh. Its own single write — the edition was already committed above.
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

/**
 * Store the user's edition and (only when minting is OPEN, and there is Spotify budget) mirror
 * it to Spotify — the one entry point for both the "Get playlist" mint and the paced sweep
 * (RFC D1/D2).
 *
 * The edition (the INTERNAL cache, the shelf's source of truth) is written FIRST and ALWAYS,
 * regardless of the kill switch or the budget. The Spotify mirror is the EXTERNAL effect and
 * stays behind the DEFAULT-DENY switch + the daily mint cap + the `last_uri_hash` mirror guard,
 * plus the shared per-app Spotify budget:
 *
 *   - Minting DARK ⇒ the edition is born (or confirmed unchanged) and NO Spotify call is
 *     made — `status: "edition_only"` when an edition was written, `"unchanged"` when the
 *     desired list matched the latest edition.
 *   - Minting OPEN, budget SPENT ⇒ the edition is written and the Spotify write is DEFERRED —
 *     `status: "building"`. The paced sweep completes the owed create/refresh in a fresh
 *     window, so a live signup never eats a 429 in their face.
 *   - Minting OPEN, budget FREE ⇒ mirror the desired list: create-once for a user with no
 *     playlist row (bounded by the rolling daily cap), or full-replace when the mirror hash
 *     moved. `status` reports the MIRROR outcome — `minted` / `refreshed` / `unchanged`.
 *
 * A settled, non-`building` outcome STAMPS the paced-drain cursor (`user_frontier_refresh`) so
 * the sweep rotates past this user for ~a week; a `building` defer or a fault leaves the cursor
 * untouched, so the user stays DUE and the next tick retries.
 *
 * Best-effort: any Spotify fault becomes `{ ok: false, reason }` — never a throw. The edition
 * has already been written by then, so a Spotify hiccup never costs the shelf its data.
 */
export async function mintOrRefreshFrontierPlaylist(
  user: PublicUser,
  nowMs: number = Date.now(),
): Promise<FrontierSyncResult> {
  try {
    const result = await syncFrontier(user, nowMs);

    // A settled outcome (the edition landed, and the mirror ran, was unchanged, or was skipped
    // by the kill switch) advances the cursor. A `building` defer must NOT — it owes a Spotify
    // write the sweep still has to complete, so the user must stay DUE.
    if (result.ok && result.status !== "building") {
      await stampFrontierRefreshed(user.id, nowMs);
    }

    return result;
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
  // True ⇒ the pass STOPPED early because the shared Spotify budget was spent. The stamps are
  // durable, so the next tick resumes from where it left off.
  budgetPaused: boolean;
  // Users whose owed Spotify write was DEFERRED this tick (budget spent mid-pass); they stay
  // DUE and the next tick completes them.
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

/**
 * One paced-drain tick — the `refresh_frontier_playlists` admin op (RFC D2), reshaped from a
 * one-shot BURST into a bounded, RESUMABLE drain so it stops colliding with the shared per-app
 * Spotify budget (which 429'd live user paths every Friday).
 *
 * It processes at most `limit` DUE committed users, PENDING MINTS FIRST (a user waiting for
 * their first playlist beats a weekly refresher), then oldest-refreshed. A user is DUE when
 * their drain cursor (`user_frontier_refresh`) is unset or older than
 * {@link FRONTIER_REFRESH_MIN_AGE_MS}, so the whole crew still refreshes ~weekly — just spread
 * across many ticks instead of one overloaded 07:00 pass.
 *
 * Runs REGARDLESS of the kill switch: the edition (the shelf's source of truth) is written for
 * every processed user; only the Spotify MIRROR stays conditional on the switch. When minting
 * is OPEN, the pass consults the shared Spotify budget before each user and STOPS cleanly when
 * the window is spent (`budgetPaused: true`) — never bursting through a hot window; the durable
 * cursor resumes next tick. A user still in the DRAFT phase (no edition AND no playlist) is
 * skipped by construction. Best-effort per user: one Spotify fault is `failed` and the walk
 * continues.
 */
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
    // Informational only now — the sweep writes editions regardless. True ⇒ the Spotify
    // mirror was skipped for every user this tick because minting is closed.
    switchOff: !mintingOpen,
    total: 0,
    unchanged: 0,
  };

  const rows = await listDueFrontierUsers(limit, nowMs);
  counts.total = rows.length;

  for (const row of rows) {
    // Pace against the shared per-app Spotify budget: when minting is OPEN and the window is
    // spent, STOP the pass cleanly — the cursor is durable, so the next tick resumes from the
    // users we did not reach. Under DARK minting the sweep makes no Spotify call, so the budget
    // never gates it (editions still flow).
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
      // A race: the budget was spent between the pre-check and the write. The user still owes a
      // Spotify write (unstamped, stays DUE) — stop the pass; the next tick resumes.
      counts.building += 1;
      counts.budgetPaused = true;
      break;
    }

    if (result.status === "minted") {
      // A user waiting for their FIRST playlist (a pending mint the hot path deferred, or a
      // pre-ledger/edition-only user opening under budget) — the create the drain completes.
      counts.minted += 1;
    } else if (result.status === "refreshed") {
      counts.refreshed += 1;
    } else if (result.status === "edition_only") {
      // The edition was written but the Spotify mirror was skipped (minting dark).
      counts.editionOnly += 1;
    } else if (result.status === "unchanged") {
      counts.unchanged += 1;
    } else {
      counts.skipped += 1;
    }
  }

  return counts;
}

/**
 * The DUE committed users the paced drain processes this tick, PENDING MINTS FIRST then oldest
 * refreshed, hydrated into the `PublicUser` shape the sync needs (the description reads the
 * handle; the recs read the id + verified flag). Commitment is the UNION of two kinds of
 * evidence:
 *
 *   - an EDITION row (the post-ledger commitment — "Get playlist" born an edition), and
 *   - a PLAYLIST row (the pre-ledger commitment — a Spotify playlist minted BEFORE editions
 *     existed; that row IS the evidence of the same "Get playlist" act from before the ledger).
 *
 * A TRUE draft user — no edition AND no playlist row — is skipped, so the drain never births
 * edition #1 for someone who never asked. The union is de-duped by user_id (a user with both
 * kinds appears once, anchored at the earliest evidence).
 *
 * DUE = no drain cursor yet (never processed — a fresh mint or a deferred pending mint), OR a
 * cursor older than {@link FRONTIER_REFRESH_MIN_AGE_MS}. Ordering puts users with NO playlist
 * row (pending creates) ahead of refreshers, then oldest-cursor (falling back to the earliest
 * commitment) first — so a user waiting for their first playlist jumps the weekly queue. All
 * per-user tables here are crew-sized (bounded by users, never the catalogue), so this is a
 * small join, not a growing-table scan.
 */
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
    // A real Spotify write fired — record it into the shared meter so the background cover
    // drain draws on the same budget as the mint + refresh (a 401/403 still spent the call).
    await recordSpotifyCall(nowMs);

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
