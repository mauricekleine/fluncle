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
  | "instagram"
  | "tiktok"
  | "twitter"
  | "facebook"
  | "mixcloud"
  | "homepage";

// The canonical platform order — the operator's add-platform Select renders in this order.
export const ARTIST_SOCIAL_PLATFORMS: ArtistSocialPlatform[] = [
  "spotify",
  "youtube",
  "soundcloud",
  "instagram",
  "tiktok",
  "mixcloud",
  "bandcamp",
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
