import { formatDuration, parseDuration } from "@fluncle/contracts/util";

// `formatDuration`/`parseDuration` are the byte-shared duration helpers — one
// definition each in `@fluncle/contracts/util` (the CLI reads the same).
// Re-exported here so every `@/lib/format` importer keeps its entrypoint.
export { formatDuration, parseDuration };

export function formatAlbumDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));

  return `${totalMinutes} min`;
}

// Pinned locale and timezone so the server-rendered date matches hydration on
// every client; VOICE.md's tabular convention is "Jun 4". Built once at module
// load — the Intl constructor allocates locale-data tables that are expensive to
// rebuild per call.
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

// The archival form with the year ("Jun 4, 2026") — the log page is a permanent
// record, so its Found date carries the year the feed omits.
const dateLongFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDateLong(value: string): string {
  return dateLongFormatter.format(new Date(value));
}

// The release date ("Jul 5, 2026") for the /tracks reference row's date column — the archival form
// with the year, matching VOICE.md's Tabular Rule ("Found Jun 4") and the "Jun 4, 2026" the rest of
// the app already ships (formatDateLong). UTC-pinned like its siblings so SSR matches hydration.
const releaseDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

// Matches a full `YYYY-MM-DD` day — the only precision we can spell out honestly. Spotify's and
// MusicBrainz's `release_date` is stored raw and can be year-only ("2026") or year-month ("2026-07").
const FULL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The /tracks row's date column. A full `YYYY-MM-DD` release date reads as the archival short-month
 * date ("Jul 5, 2026"); a partial-precision date stays honest at the YEAR alone (never fabricating a
 * month or day the source never gave — `new Date("2026")` would otherwise render "Jan 1"); an
 * empty/absent value shows an em dash.
 */
export function formatReleaseDate(releaseDate: string): string {
  if (FULL_DAY.test(releaseDate)) {
    return releaseDateFormatter.format(new Date(releaseDate));
  }

  return releaseDate.slice(0, 4) || "—";
}

export function formatDurationField(durationMs?: number | null): string {
  return durationMs ? formatDuration(durationMs) : "";
}

/**
 * "1 finding" / "12 findings" — the ONE place the noun is pluralized.
 *
 * A finding is the only named object in Fluncle's world, so its count is printed on half the
 * surfaces in the app (the label/album/artist cards, the galaxy cards, the admin rows), and
 * every one of them used to inline its own `count === 1 ? … : …`. That is a bug per copy of
 * the ternary waiting to happen, and one of them shipped ("1 findings"). Counting is not a
 * per-surface decision; it is arithmetic. Route every count string through here.
 */
export function findingsCount(count: number): string {
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}

/**
 * "1 banger" / "12 bangers" — the count noun for a mixtape's members (the tunes on the set),
 * the sibling of {@link findingsCount}. A mixtape carries bangers, not findings; routing its
 * count through here keeps the pluralization arithmetic in one place, same as findings.
 */
export function bangersCount(count: number): string {
  return `${count} ${count === 1 ? "banger" : "bangers"}`;
}

/**
 * "1 track" / "12 tracks" — the count noun for a catalogue entity's renderable tracks (the
 * quiet count on a hub's "also in the catalogue" tile). Deliberately NOT `findingsCount`: a
 * catalogue entity is one Fluncle has certified nothing on, so its tiles count plain TRACKS,
 * never findings (docs/album-entity.md, the unnamed tier). Same one-place pluralization.
 */
export function tracksCount(count: number): string {
  return `${count} ${count === 1 ? "track" : "tracks"}`;
}

export function formatIsoDuration(durationMs: number): string {
  // schema.org duration (ISO-8601), e.g. "PT3M37S".
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `PT${minutes}M${seconds}S`;
}
