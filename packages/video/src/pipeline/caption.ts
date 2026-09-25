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

export function yearFromReleaseDate(releaseDate: string | null | undefined): number | null {
  if (!releaseDate) {
    return null;
  }

  const year = Number.parseInt(releaseDate.slice(0, 4), 10);

  return Number.isFinite(year) ? year : null;
}

export function formatFound(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return "Found";
  }

  return `Found ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

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

export function buildCaption(track: CaptionTrack, year: number | null): string {
  if (!track.logId) {
    throw new Error("buildCaption: track has no Log ID (every video needs a coordinate)");
  }

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
