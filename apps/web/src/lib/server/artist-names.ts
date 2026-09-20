import { logEvent } from "./log";

export function parseArtistsJson(value: string): string[] {
  try {
    const artists = JSON.parse(value) as unknown;

    if (Array.isArray(artists)) {
      return artists.filter((artist): artist is string => typeof artist === "string");
    }
  } catch (error) {
    logEvent("warn", "artists.parse-artists-json-failed", { error });
    return [];
  }

  return [];
}
