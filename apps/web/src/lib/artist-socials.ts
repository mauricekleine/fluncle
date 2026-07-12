// Client-safe artist-socials surface: the platform vocabulary + a pure http(s) URL guard.
// This lives OUTSIDE lib/server on purpose — the `/admin/artists` route renders the
// platform Select and the href guard in client code, so importing these VALUES from the
// server module (`lib/server/artists`, which pulls in node:crypto + spotify/youtube/db)
// dragged that whole module into the client bundle and crashed the page (node:crypto
// externalized). The server module imports the type + list back from here.

export type ArtistSocialPlatform =
  | "spotify"
  | "youtube"
  | "soundcloud"
  | "bandcamp"
  | "beatport"
  | "instagram"
  | "tiktok"
  | "twitter"
  | "facebook"
  | "mixcloud"
  | "twitch"
  | "homepage";

// The canonical platform order — the operator's add-platform Select renders in this order.
export const ARTIST_SOCIAL_PLATFORMS: ArtistSocialPlatform[] = [
  "spotify",
  "youtube",
  "soundcloud",
  "instagram",
  "tiktok",
  "mixcloud",
  "twitch",
  "bandcamp",
  "beatport",
  "twitter",
  "facebook",
  "homepage",
];

// A pure http(s)-scheme guard (self-contained, no server deps). The render side only emits
// an `<a href>` when this passes; the server WRITE path uses `assertHttpUrl` (which throws)
// in `lib/server/artists`.
export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw.trim());

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Map a URL's host → the social platform it belongs to, for the fresh-links inline editor's
// INSTANT client-side feedback ONLY. The SERVER is authoritative: on Save it re-validates and
// normalizes through `classifyMbUrl` + `normalizeProfileUrl` (lib/server/artist-resolution).
// This mirrors that classifier's common host rules so a plainly-wrong paste (an instagram.com
// URL in a YouTube row) is caught before the round-trip; a host it can't place returns null and
// defers to the server's ruling. Kept client-safe (no server deps) for the same bundle reason
// as `isHttpUrl` above.
function platformOfHost(raw: string): ArtistSocialPlatform | null {
  let host: string;

  try {
    host = new URL(raw.trim()).hostname.replace(/^(www\.|music\.)/, "");
  } catch {
    return null;
  }

  if (host === "open.spotify.com") {
    return "spotify";
  }
  if (host === "youtube.com" || host === "youtu.be") {
    return "youtube";
  }
  if (host === "mixcloud.com") {
    return "mixcloud";
  }
  if (host === "soundcloud.com") {
    return "soundcloud";
  }
  if (host === "instagram.com") {
    return "instagram";
  }
  if (host === "tiktok.com") {
    return "tiktok";
  }
  if (host === "bandcamp.com" || raw.includes(".bandcamp.com")) {
    return "bandcamp";
  }
  if (host === "beatport.com") {
    return "beatport";
  }
  if (host === "twitter.com" || host === "x.com") {
    return "twitter";
  }
  if (host === "facebook.com" || host === "fb.com") {
    return "facebook";
  }
  if (host === "twitch.tv") {
    return "twitch";
  }

  return null;
}

// The cheap client-side gate the inline editor's Save uses: does this URL's host plausibly
// belong to the row's platform? A `homepage` accepts any host that ISN'T a recognized social
// (those belong in their own row); every other platform requires an exact host match. Loose by
// design — an unrecognized host passes (returns true) so the SERVER makes the final call.
export function urlHostMatchesPlatform(platform: ArtistSocialPlatform, raw: string): boolean {
  const detected = platformOfHost(raw);

  if (platform === "homepage") {
    return detected === null;
  }

  return detected === null || detected === platform;
}
