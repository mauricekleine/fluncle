import { listCatalogueTracks } from "./catalogue";
import { logEvent } from "./log";
import { getSetting, setSetting } from "./settings";
import { getSpotifyAccessToken, spotifyFetch } from "./spotify";

export const TELESCOPE_PLAYLIST_SETTING = "telescope.spotify_playlist_id";

export const TELESCOPE_MIRROR_SETTING = "telescope.last_mirror";

const TELESCOPE_PLAYLIST_SIZE = 50;

const TELESCOPE_POOL_DEPTH = 200;

const TELESCOPE_PLAYLIST_NAME = "Fluncle's Telescope";
const TELESCOPE_PLAYLIST_DESCRIPTION =
  "What the telescope is pointed at. Candidates, not findings. The log decides.";

async function step<T>(name: string, request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function spotifyUriFromUrl(url: null | string): null | string {
  if (!url) {
    return null;
  }

  const match = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/.exec(url);

  return match?.[1] ? `spotify:track:${match[1]}` : null;
}

async function ensureTelescopePlaylist(accessToken: string): Promise<string> {
  const stored = await getSetting(TELESCOPE_PLAYLIST_SETTING);

  if (stored) {
    return stored;
  }

  const me = (await (await step("me", spotifyFetch("/me", accessToken))).json()) as {
    id: string;
  };
  const created = (await (
    await step(
      "create",
      spotifyFetch(`/users/${me.id}/playlists`, accessToken, {
        body: JSON.stringify({
          description: TELESCOPE_PLAYLIST_DESCRIPTION,
          name: TELESCOPE_PLAYLIST_NAME,
          public: false,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    )
  ).json()) as { id: string };

  await setSetting(TELESCOPE_PLAYLIST_SETTING, created.id);
  logEvent("info", "telescope.playlist-created", { playlistId: created.id });

  return created.id;
}

export type TelescopeSyncResult =
  | { changed: boolean; ok: true; size: number }
  | { ok: false; reason: string };

export async function syncTelescopePlaylist(): Promise<TelescopeSyncResult> {
  try {
    const rows = await listCatalogueTracks("ear", TELESCOPE_POOL_DEPTH);
    const desired = rows
      .map((row) => spotifyUriFromUrl(row.spotifyUrl))
      .filter((uri): uri is string => uri !== null)
      .slice(0, TELESCOPE_PLAYLIST_SIZE);

    const mirror = desired.join(",");
    const lastMirror = await getSetting(TELESCOPE_MIRROR_SETTING);
    const changed = mirror !== lastMirror;

    if (changed) {
      const accessToken = await getSpotifyAccessToken();
      const playlistId = await ensureTelescopePlaylist(accessToken);

      await step(
        "replace",
        spotifyFetch(`/playlists/${playlistId}/items`, accessToken, {
          body: JSON.stringify({ uris: desired }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        }),
      );

      await setSetting(TELESCOPE_MIRROR_SETTING, mirror);
    }

    return { changed, ok: true, size: desired.length };
  } catch (error) {
    logEvent("warn", "telescope.sync-failed", { error });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  }
}
