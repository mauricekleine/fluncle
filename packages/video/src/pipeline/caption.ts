// Caption generator for a track's social video. A FIXED template (deterministic,
// not free prose) in Fluncle's voice (VOICE.md):
//
//   Artist — Title (Year)
//   Label
//
//   Found Jun 8: fluncle://<log-id>
//
//   #dnb #drumnbass #drumandbass #<subgenre>…
//
// - `Artist — Title` is the only sanctioned em dash (VOICE.md §6); multi-artist
//   joins with ", ". Year and Label degrade gracefully when unknown.
// - The "Found <date>" stamp uses the FOUND date (added_at), UTC, no leading
//   zero — matching the on-screen FloatingType stamp exactly (the Found Rule).
// - The `(Year)` is the RELEASE year (a catalog credit, like the label); the
//   explicit "Found" label keeps it distinct from Fluncle's own date.
// - Hashtags: a fixed D&B base + the track's sub-genre tags, lowercased,
//   stripped to alphanumerics, and deduped.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BASE_HASHTAGS = ["dnb", "drumnbass", "drumandbass"];

export type CaptionTrack = {
  addedAt: string;
  artists: string[];
  isrc?: string | null;
  label?: string | null;
  logId?: string | null;
  tags?: string[] | null;
  title: string;
};

/** "Found Jun 8" — the found date, UTC, no leading zero (matches FloatingType). */
function formatFound(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return "Found";
  }

  return `Found ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A tag → bare hashtag token: lowercase, alphanumerics only ("liquid funk" → "liquidfunk"). */
function toHashtag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The release YEAR for a track from Deezer (by ISRC). Null when unresolved. */
export async function fetchReleaseYear(isrc: string | null | undefined): Promise<number | null> {
  if (!isrc) {
    return null;
  }

  try {
    const response = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
    const track = (await response.json()) as { error?: unknown; release_date?: string };

    if (track.error || !track.release_date) {
      return null;
    }

    const year = Number.parseInt(track.release_date.slice(0, 4), 10);

    return Number.isFinite(year) ? year : null;
  } catch {
    return null;
  }
}

/** Build the fixed-template caption. `year` is the release year (or null). */
export function buildCaption(track: CaptionTrack, year: number | null): string {
  if (!track.logId) {
    throw new Error("buildCaption: track has no Log ID (every video needs a coordinate)");
  }

  // The only sanctioned em dash in the system (VOICE.md §6).
  const artist = track.artists.join(", ");
  const titleLine = year ? `${artist} — ${track.title} (${year})` : `${artist} — ${track.title}`;

  const lines = [titleLine];
  const label = track.label?.trim();

  if (label) {
    lines.push(label);
  }

  lines.push("", `${formatFound(track.addedAt)}: fluncle://${track.logId}`, "");

  const tags = (track.tags ?? []).map(toHashtag).filter(Boolean);
  const hashtags = [...new Set([...BASE_HASHTAGS, ...tags])].map((t) => `#${t}`).join(" ");
  lines.push(hashtags);

  return `${lines.join("\n")}\n`;
}
