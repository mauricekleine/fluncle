// Caption generator for a track's social video. A FIXED template (deterministic,
// not free prose) in Fluncle's voice (VOICE.md):
//
//   Artist — Title (Year)
//   Label
//
//   Found Jun 8: fluncle://<log-id>
//
//   #dnb #drumnbass #drumandbass
//
// - `Artist — Title` is the only sanctioned em dash (VOICE.md §6); multi-artist
//   joins with ", ". Year and Label degrade gracefully when unknown.
// - The "Found <date>" stamp uses the FOUND date (added_at), UTC, no leading
//   zero — matching the on-screen FloatingType stamp exactly (the Found Rule).
// - The `(Year)` is the RELEASE year (a catalog credit, like the label); the
//   explicit "Found" label keeps it distinct from Fluncle's own date.
// - Hashtags: a fixed D&B base. Per-track sub-genre tags were removed in fbad929
//   (grouping is now the vibe-map); the caption carries the base set only.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BASE_HASHTAGS = ["dnb", "drumnbass", "drumandbass"];

export type CaptionTrack = {
  addedAt: string;
  artists: string[];
  isrc?: string | null;
  label?: string | null;
  logId?: string | null;
  releaseDate?: string | null;
  title: string;
};

/** Release year from a stored release_date ("2015-03-20" → 2015). Null when unset. */
export function yearFromReleaseDate(releaseDate: string | null | undefined): number | null {
  if (!releaseDate) {
    return null;
  }

  const year = Number.parseInt(releaseDate.slice(0, 4), 10);

  return Number.isFinite(year) ? year : null;
}

/** "Found Jun 8" — the found date, UTC, no leading zero (matches FloatingType). */
export function formatFound(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return "Found";
  }

  return `Found ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
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

    return yearFromReleaseDate(track.release_date);
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

  const hashtags = BASE_HASHTAGS.map((t) => `#${t}`).join(" ");
  lines.push(hashtags);

  return `${lines.join("\n")}\n`;
}
