import { getDb } from "./db";
import { logEvent } from "./log";

// Bare `@handle` artist-credit lines woven into a finding's social caption at push/copy
// time (operator-ratified). No verb, no prose — the caption already says "Found" once, so
// the credit is the handle alone. The rules, all ratified:
//
//   - WHO: every LEAD artist (`track_artists.role IS NULL`, remixers untagged) with a
//     usable handle for the target platform, primary/order first, capped at 3.
//   - TRUST GATE (absolute): only `artist_socials` rows with `status IN ('auto','confirmed')`
//     — never `candidate`. No handle → no line → the caption is byte-identical to today.
//     A handle is never guessed or derived from a name.
//   - HANDLE FORM: both platforms mention by the `/@handle` path segment. A YouTube social
//     stored as `/channel/UC…`, `/c/…`, or `/user/…` carries no @-mentionable handle, so it
//     is skipped; only the `/@handle` form is usable.
//   - LENGTH: assemble, then enforce the platform cap by dropping handles LAST-ARTIST-FIRST.
//     The identity line, the Found/coordinate line, and the hashtags are never truncated.
//
// The lookup reads the FRESHEST `artist_socials` trust state on every push/copy — never
// baked into the rendered `note.txt`, so a handle confirmed after render still reaches an
// already-rendered bundle, and each platform gets ITS OWN handle for the same artist
// (a YouTube description mentions the YouTube handle; a TikTok caption the TikTok handle).

/** The two platforms a mention line is ever woven for (YouTube description, TikTok caption). */
export type MentionPlatform = "tiktok" | "youtube";

/** The most credit lines a caption ever carries — operator-ratified. */
export const MAX_MENTION_HANDLES = 3;

/**
 * Platform caption caps, verified against the platforms' 2026 docs:
 *   - YouTube description: 5,000 characters.
 *   - TikTok caption: 2,200 (the third-party scheduler / API limit; the native app now
 *     allows 4,000). Fluncle pushes TikTok via Postiz AND the operator pastes the same
 *     text in-app, so the conservative 2,200 floor keeps one caption safe on both paths.
 */
export const PLATFORM_CAPTION_CAP: Record<MentionPlatform, number> = {
  tiktok: 2200,
  youtube: 5000,
};

/**
 * Parse the usable `@handle` from a stored social profile URL, or undefined. Both TikTok
 * and YouTube mention by the leading `/@handle` path segment; a YouTube channel URL
 * (`/channel/UC…`, `/c/…`, `/user/…`) has no leading `@`, so it returns undefined and the
 * artist gets no mention on that platform.
 */
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

/**
 * The finding's trusted lead-artist handles for one platform, primary-first, deduped, and
 * capped at {@link MAX_MENTION_HANDLES}. The WHO + the TRUST GATE live in the SQL (`role is
 * null`, `status in ('auto','confirmed')`), so a candidate row can never leak in; the parse
 * gate drops any row without a `/@handle` form. Best-effort by contract: a failed read
 * returns [] (the caption stays byte-identical) — a mention lookup must never block a push.
 */
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
            join artist_socials s on s.artist_id = ta.artist_id
            where ta.track_id = ?
              and ta.role is null
              and s.platform = ?
              and s.status in ('auto', 'confirmed')
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

/**
 * Insert the credit line (all handles, space-joined) into a fixed-template caption right
 * after the identity/label block — before the blank line that precedes the Found line
 * (`buildCaption`'s shape: title / label? / "" / Found / "" / hashtags). Returns the
 * caption unchanged when there are no handles, or when the caption doesn't match the
 * expected shape (never risk mangling the identity/Found/hashtag lines).
 */
export function injectMentionLine(caption: string, handles: string[]): string {
  if (handles.length === 0) {
    return caption;
  }

  const line = handles.join(" ");
  const lines = caption.split("\n");
  // The first blank line is the separator right after the title/label block; the mention
  // line slots in just above it. A legacy caption with no blank falls back to the
  // Found/coordinate line; a caption matching neither is left untouched.
  const blankIdx = lines.indexOf("");
  const insertAt = blankIdx > 0 ? blankIdx : lines.findIndex((l) => l.includes("fluncle://"));

  if (insertAt <= 0) {
    return caption;
  }

  lines.splice(insertAt, 0, line);

  return lines.join("\n");
}

/**
 * Assemble the caption with as many mention handles as fit under the platform cap, dropping
 * handles LAST-ARTIST-FIRST until it fits. If even the bare caption exceeds the cap it is
 * returned unchanged — the mention feature never truncates the identity line, the
 * Found/coordinate line, or the hashtags.
 */
export function captionWithMentions(caption: string, handles: string[], cap: number): string {
  for (let count = handles.length; count > 0; count--) {
    const candidate = injectMentionLine(caption, handles.slice(0, count));

    if (candidate.length <= cap) {
      return candidate;
    }
  }

  return caption;
}

/**
 * The caption a platform actually receives: the bundle's `note.txt` with the finding's
 * trusted lead-artist `@handles` for THAT platform woven in, under the platform cap.
 * Byte-identical to `caption` when no lead artist has a usable trusted handle (or the
 * caption is empty). This is the ONE seam the push path and the operator's copy-caption
 * surface share, so the two can never drift on who gets credited.
 */
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
