// Normalized title+artist track matching — the TS port of the ratified matcher in
// packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py (`_fold`,
// `_normalize_artists`, `_split_title`, `match_key`). Used wherever a bare
// `{ artists, title }` cue must resolve to a Fluncle finding WITHOUT an id (the
// plan→recording→mixtape backfill, and the legacy `tracklist_json` dual-read in
// `promoteRecording`). Match discipline, identical to the Python source:
//   - case/accent-folded, `&`↔`and`, punctuation dropped, whitespace collapsed;
//   - `feat.` credits dropped (a "A feat. B" matches a stored ["A"]);
//   - a REMIX / VIP / edit is a DIFFERENT recording — its mix-descriptor is part
//     of the identity, so "Song (Calibre Remix)" never matches the original;
//   - anything ambiguous resolves to NOTHING (honest silence over a wrong link).

// Words that mark a parenthetical / dash-suffix as a distinct VERSION of a track.
const VERSION_WORDS = new Set([
  "bootleg",
  "dub",
  "edit",
  "extended",
  "flip",
  "instrumental",
  "mix",
  "refix",
  "remaster",
  "remix",
  "rework",
  "rmx",
  "version",
  "vip",
]);

// Suffixes that name a version but are NOT distinguishing — they are the original.
const NEUTRAL_DESCRIPTORS = new Set([
  "original mix",
  "original",
  "extended mix",
  "original version",
]);

const ARTIST_SPLIT = /\s*(?:,|&|\/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*/;
const FEAT_INLINE = /\b(?:feat|ft|featuring)\b\.?.*$/i;
const PUNCT = /[^a-z0-9 ]+/g;
const WS = /\s+/g;

function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, strip accents, fold `&`→`and`, drop punctuation, collapse spaces. */
export function fold(text: string): string {
  const folded = stripAccents(text).toLowerCase().replaceAll("&", " and ");

  return folded.replace(PUNCT, " ").replace(WS, " ").trim();
}

/**
 * The set of individual, folded artist names — order- and separator-agnostic.
 * Accepts Fluncle's `string[]` or a joined single string ("A, B" / "A & B");
 * drops `feat.` credits.
 */
export function normalizeArtists(artists: string[] | string): Set<string> {
  const raw = (Array.isArray(artists) ? artists.join(", ") : artists).replace(FEAT_INLINE, "");
  const names = new Set<string>();

  for (const part of raw.split(ARTIST_SPLIT)) {
    const name = fold(part);

    if (name) {
      names.add(name);
    }
  }

  return names;
}

/**
 * `(base title, version descriptor)` — the base with feat./mix suffixes removed,
 * plus the distinguishing version descriptor ("" for the original).
 */
export function splitTitle(title: string): { base: string; descriptor: string } {
  let working = title;
  let descriptor = "";

  // Trailing parenthetical / bracket groups, right to left.
  const groups = [...working.matchAll(/[([]([^)\]]*)[)\]]/g)];

  for (const match of groups.reverse()) {
    const start = match.index;
    const end = start + match[0].length;
    const foldedInner = fold(match[1] ?? "");

    if (!foldedInner) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    // A feat. credit in the title is not a version — drop it from the base.
    if (/^(?:feat|ft|featuring)\b/.test(foldedInner)) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    const tokens = new Set(foldedInner.split(" "));
    const isVersion = [...tokens].some((token) => VERSION_WORDS.has(token));

    if (isVersion && !NEUTRAL_DESCRIPTORS.has(foldedInner)) {
      descriptor = foldedInner;
    }

    // Version or subtitle, either way it leaves the base (a stored/absent
    // subtitle still matches).
    working = working.slice(0, start) + working.slice(end);
  }

  // A dash-suffixed version: "Song - Calibre Remix".
  const dash = working.match(/\s[-–—]\s(.+)$/);

  if (dash && dash.index !== undefined) {
    const foldedSuffix = fold(dash[1] ?? "");
    const suffixTokens = new Set(foldedSuffix.split(" "));

    if ([...suffixTokens].some((token) => VERSION_WORDS.has(token))) {
      if (!NEUTRAL_DESCRIPTORS.has(foldedSuffix) && !descriptor) {
        descriptor = foldedSuffix;
      }

      working = working.slice(0, dash.index);
    }
  }

  // Drop an inline feat. from the base too.
  working = working.replace(FEAT_INLINE, "");

  return { base: fold(working), descriptor };
}

/**
 * The identity two rows must share to be the same recording, as a stable string
 * key: sorted artist set + base title + version descriptor. Pure + deterministic.
 */
export function matchKey(artists: string[] | string, title: string): string {
  const { base, descriptor } = splitTitle(title);
  const names = [...normalizeArtists(artists)].sort();

  return JSON.stringify([names, base, descriptor]);
}

/**
 * The remixer-credit derivation (RFC label-lineage-remixer, U2): the subset of `artists` a track's
 * TITLE names as its remixer — and NOTHING beyond an EXACT fold match, so a credit is never guessed.
 *
 * The title's version descriptor ("(Calibre Remix)", "Song - S.P.Y VIP") names the remixer; strip
 * the VERSION word(s) off it (`splitTitle` already folded it) and the remainder is the remixer name
 * ("calibre", "s p y"). We return only the `artists` whose folded name EQUALS one of those, so an
 * uncertified remixer the archive has no `artists` row for is never invented, and a co-remix
 * ("Calibre & Fabio Remix") resolves to BOTH when both are credited (`normalizeArtists` splits the
 * remainder on `&`/`and`/…). Empty when the title carries no version descriptor, when stripping the
 * version words leaves nothing (a bare "(Remix)"/"(VIP)"), or when no credited artist folds to it.
 *
 * PURE + deterministic, and the SINGLE source of truth for the credit: the DB stamp
 * (`stampRemixerRoles`, artists.ts) and the JSON-LD emit (log-schema.ts) both read it, so the
 * `track_artists.role` column and the MusicRecording `contributor` markup agree by construction.
 */
export function deriveRemixerNames(title: string, artists: string[]): string[] {
  const { descriptor } = splitTitle(title);

  if (!descriptor) {
    return [];
  }

  const nameTokens = descriptor.split(" ").filter((token) => token && !VERSION_WORDS.has(token));

  if (nameTokens.length === 0) {
    return [];
  }

  const candidates = normalizeArtists(nameTokens.join(" "));

  if (candidates.size === 0) {
    return [];
  }

  return artists.filter((name) => candidates.has(fold(name)));
}

/** A catalogue entry the matcher indexes — a finding's identity + its id. */
export type CatalogueTrack = {
  artists: string[] | string;
  title: string;
  trackId: string;
};

/**
 * Build a matchKey → trackId index over the findings catalogue. An identity shared
 * by MORE than one finding maps to `null` (ambiguous — never guessed), mirroring
 * rekordbox_sync.py's compute_diff discipline.
 */
export function buildTrackMatchIndex(catalogue: CatalogueTrack[]): Map<string, string | null> {
  const index = new Map<string, string | null>();

  for (const track of catalogue) {
    const key = matchKey(track.artists, track.title);
    const existing = index.get(key);

    if (existing === undefined) {
      index.set(key, track.trackId);
    } else if (existing !== track.trackId) {
      index.set(key, null);
    }
  }

  return index;
}

/** Resolve one `{ artists, title }` to a trackId via the index, or null (honest). */
export function resolveTrackByText(
  index: Map<string, string | null>,
  artists: string[] | string,
  title: string,
): string | null {
  return index.get(matchKey(artists, title)) ?? null;
}

/** The fields the recording-identity fold reads off a catalogue row. */
export type RecordingIdentity = {
  artists: string[] | string;
  isrc: string | null | undefined;
  releaseDate: string | null | undefined;
  spotifyUrl: string | null | undefined;
  title: string;
  trackId: string;
};

/**
 * The RENDER-TIME half of the duplicate defence. The SQL reads already drop rows an operator has
 * STAMPED as duplicates (`duplicate_of_track_id` / `dismissed_at`), but the crawler leaves most
 * twins unstamped — the SAME recording reissued under a second barcode — so the graph pages fold
 * whatever the stamping has not caught over the bounded slice they load.
 *
 * Rows sharing one {@link matchKey} identity collapse to ONE representative, and the kept row is
 * the most ANCHORED: a Spotify-anchored row wins, then an ISRC-bearing one, then the newest
 * release, then the lowest track id — a stable final tiebreak so the choice is deterministic
 * regardless of the order the rows arrive in. First-appearance order is otherwise preserved, so a
 * fold never reshuffles the list the SQL already ordered.
 */
export function dedupeByRecordingIdentity<T>(
  rows: T[],
  identify: (row: T) => RecordingIdentity,
): T[] {
  const order: string[] = [];
  const best = new Map<string, { id: RecordingIdentity; row: T }>();

  for (const row of rows) {
    const id = identify(row);
    const key = matchKey(id.artists, id.title);
    const held = best.get(key);

    if (!held) {
      best.set(key, { id, row });
      order.push(key);
    } else if (isMoreAnchored(id, held.id)) {
      best.set(key, { id, row });
    }
  }

  const kept: T[] = [];

  for (const key of order) {
    const held = best.get(key);

    if (held) {
      kept.push(held.row);
    }
  }

  return kept;
}

/** True when `candidate` is the better representative of a recording than `current`. */
function isMoreAnchored(candidate: RecordingIdentity, current: RecordingIdentity): boolean {
  const candidateSpotify = candidate.spotifyUrl ? 1 : 0;
  const currentSpotify = current.spotifyUrl ? 1 : 0;

  if (candidateSpotify !== currentSpotify) {
    return candidateSpotify > currentSpotify;
  }

  const candidateIsrc = candidate.isrc ? 1 : 0;
  const currentIsrc = current.isrc ? 1 : 0;

  if (candidateIsrc !== currentIsrc) {
    return candidateIsrc > currentIsrc;
  }

  const candidateDate = candidate.releaseDate ?? "";
  const currentDate = current.releaseDate ?? "";

  if (candidateDate !== currentDate) {
    return candidateDate > currentDate;
  }

  return candidate.trackId < current.trackId;
}
