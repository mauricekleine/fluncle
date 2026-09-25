import { listedArtistWhere } from "./artist-visibility";
import { getDb } from "./db";
import { logEvent } from "./log";

export type MentionPlatform = "tiktok" | "youtube";

export const MAX_MENTION_HANDLES = 3;

const PLATFORM_CAPTION_CAP: Record<MentionPlatform, number> = {
  tiktok: 2200,
  youtube: 5000,
};

export function parseMentionHandle(url: string): string | undefined {
  let pathname: string;

  try {
    pathname = new URL(url.trim()).pathname;
  } catch {
    return undefined;
  }

  const match = pathname.match(/^\/@([A-Za-z0-9._-]+)/);

  return match ? `@${match[1]}` : undefined;
}

export async function mentionHandlesFor(
  trackId: string,
  platform: MentionPlatform,
): Promise<string[]> {
  let rows: unknown[];

  try {
    const db = await getDb();
    const result = await db.execute({
      args: [trackId, platform],
      sql: `select s.url as url
            from track_artists ta
            join artists on artists.id = ta.artist_id
            join artist_socials s on s.artist_id = ta.artist_id
            where ta.track_id = ?
              and ta.role is null
              and s.platform = ?
              and s.status in ('auto', 'confirmed')
              and ${listedArtistWhere()}
            order by ta.position asc`,
    });

    rows = result.rows;
  } catch (error) {
    logEvent("warn", "mentions.lookup-failed", { error, platform, trackId });

    return [];
  }

  const handles: string[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    const url = (raw as Record<string, unknown>)["url"];

    if (typeof url !== "string") {
      continue;
    }

    const handle = parseMentionHandle(url);

    if (!handle) {
      continue;
    }

    const key = handle.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    handles.push(handle);

    if (handles.length >= MAX_MENTION_HANDLES) {
      break;
    }
  }

  return handles;
}

export function injectMentionLine(caption: string, handles: string[]): string {
  if (handles.length === 0) {
    return caption;
  }

  const line = handles.join(" ");
  const lines = caption.split("\n");

  const blankIdx = lines.indexOf("");
  const insertAt = blankIdx > 0 ? blankIdx : lines.findIndex((l) => l.includes("fluncle://"));

  if (insertAt <= 0) {
    return caption;
  }

  lines.splice(insertAt, 0, line);

  return lines.join("\n");
}

export function captionWithMentions(caption: string, handles: string[], cap: number): string {
  for (let count = handles.length; count > 0; count--) {
    const candidate = injectMentionLine(caption, handles.slice(0, count));

    if (candidate.length <= cap) {
      return candidate;
    }
  }

  return caption;
}

export async function captionForPlatform(
  trackId: string,
  platform: MentionPlatform,
  caption: string,
): Promise<string> {
  if (!caption || !trackId) {
    return caption;
  }

  const handles = await mentionHandlesFor(trackId, platform);

  if (handles.length === 0) {
    return caption;
  }

  return captionWithMentions(caption, handles, PLATFORM_CAPTION_CAP[platform]);
}
