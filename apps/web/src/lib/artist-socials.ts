export type ArtistSocialPlatform =
  | "spotify"
  | "youtube"
  | "soundcloud"
  | "bandcamp"
  | "beatport"
  | "instagram"
  | "tiktok"
  | "bluesky"
  | "twitter"
  | "facebook"
  | "mixcloud"
  | "twitch"
  | "homepage";

export const ARTIST_SOCIAL_PLATFORMS: ArtistSocialPlatform[] = [
  "spotify",
  "youtube",
  "soundcloud",
  "instagram",
  "tiktok",
  "bluesky",
  "mixcloud",
  "twitch",
  "bandcamp",
  "beatport",
  "twitter",
  "facebook",
  "homepage",
];

export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw.trim());

    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

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
  if (host === "bsky.app") {
    return "bluesky";
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

export function urlHostMatchesPlatform(platform: ArtistSocialPlatform, raw: string): boolean {
  const detected = platformOfHost(raw);

  if (platform === "homepage") {
    return detected === null;
  }

  return detected === null || detected === platform;
}
