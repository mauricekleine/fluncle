// FLUNCLE'S TELESCOPE — the discovery loop closed (operator ruling, 2026-07-15).
//
// The ear's diversified top rows, mirrored into a PRIVATE Spotify playlist the operator
// listens to through the day. The playlist is NEVER curated by hand: it is a pure mirror
// of the telescope, so every act that changes the ranking changes the playlist on the
// next sync — logging a find removes it (the certification anti-join), a thumbs-down
// removes it (the dismiss), a better candidate displaces a weaker one. PRIVATE is
// load-bearing: these are candidates, not findings, and the public promise (the Findings
// playlist, 100% bangers) never carries a "maybe".
//
// The mirror is a FULL REPLACE, not a diff: the desired list is ≤50 URIs (one PUT), the
// order IS the ranking, and replace is idempotent — no drift, no orphan tracks, nothing
// to reconcile. A sync with an unchanged list makes one GET and stops.
//
// Best-effort by design: the sync rides the rank sweep and the operator's certify/dismiss
// acts, and a Spotify hiccup must never fail those. Callers use `syncTelescopePlaylist()`
// and get `{ ok: false }` back on failure — logged, never thrown.

import { listCatalogueTracks } from "./catalogue";
import { logEvent } from "./log";
import { getSetting, setSetting } from "./settings";
import { getSpotifyAccessToken, spotifyFetch } from "./spotify";

/** The settings-KV key holding the created playlist's Spotify id. */
export const TELESCOPE_PLAYLIST_SETTING = "telescope.spotify_playlist_id";

/** How many anchored rows the playlist mirrors. */
export const TELESCOPE_PLAYLIST_SIZE = 50;

/**
 * How deep down the diversified ranking the sync walks to find them. The telescope's best
 * candidates are largely NOT on Spotify (crawler-born deep catalogue — the whole point of
 * reaching past Spotify), so "top 50, drop the unanchored" would mirror a near-empty
 * playlist. The mirror instead takes the first SIZE anchored rows in diversified order.
 */
const TELESCOPE_POOL_DEPTH = 200;

const TELESCOPE_PLAYLIST_NAME = "Fluncle's Telescope";
const TELESCOPE_PLAYLIST_DESCRIPTION =
  "What the telescope is pointed at. Candidates, not findings. The log decides.";

/** `open.spotify.com/track/<id>` → `spotify:track:<id>`; null for anything else. */
export function spotifyUriFromUrl(url: null | string): null | string {
  if (!url) {
    return null;
  }

  const match = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/.exec(url);

  return match?.[1] ? `spotify:track:${match[1]}` : null;
}

/**
 * The playlist's Spotify id — created once (private, on the grant's own account) and
 * remembered on the settings KV. Creation is lazy: the first sync mints it.
 */
async function ensureTelescopePlaylist(accessToken: string): Promise<string> {
  const stored = await getSetting(TELESCOPE_PLAYLIST_SETTING);

  if (stored) {
    return stored;
  }

  const me = (await (await spotifyFetch("/me", accessToken)).json()) as { id: string };
  const created = (await (
    await spotifyFetch(`/users/${me.id}/playlists`, accessToken, {
      body: JSON.stringify({
        description: TELESCOPE_PLAYLIST_DESCRIPTION,
        name: TELESCOPE_PLAYLIST_NAME,
        public: false,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).json()) as { id: string };

  await setSetting(TELESCOPE_PLAYLIST_SETTING, created.id);
  logEvent("info", "telescope.playlist-created", { playlistId: created.id });

  return created.id;
}

export type TelescopeSyncResult =
  | { changed: boolean; ok: true; size: number }
  | { ok: false; reason: string };

/**
 * Mirror the diversified ear top into the private playlist. One GET when nothing
 * changed; one PUT (full ordered replace) when anything did.
 */
export async function syncTelescopePlaylist(): Promise<TelescopeSyncResult> {
  try {
    const rows = await listCatalogueTracks("ear", TELESCOPE_POOL_DEPTH);
    const desired = rows
      .map((row) => spotifyUriFromUrl(row.spotifyUrl))
      .filter((uri): uri is string => uri !== null)
      .slice(0, TELESCOPE_PLAYLIST_SIZE);

    const accessToken = await getSpotifyAccessToken();
    const playlistId = await ensureTelescopePlaylist(accessToken);

    const current = (await (
      await spotifyFetch(
        `/playlists/${playlistId}/tracks?fields=items(track(uri)),total&limit=100`,
        accessToken,
      )
    ).json()) as { items?: { track?: { uri?: string } }[] };
    const currentUris = (current.items ?? []).map((item) => item.track?.uri ?? "");

    const changed =
      currentUris.length !== desired.length ||
      currentUris.some((uri, index) => uri !== desired[index]);

    if (changed) {
      await spotifyFetch(`/playlists/${playlistId}/tracks`, accessToken, {
        body: JSON.stringify({ uris: desired }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
    }

    return { changed, ok: true, size: desired.length };
  } catch (error) {
    logEvent("warn", "telescope.sync-failed", { error });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  }
}
