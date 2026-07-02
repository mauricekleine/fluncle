// Normalized title+artist track matching — the TS port of the ratified matcher in
// packages/skills/fluncle-key-backfill/scripts/key_backfill.py (`_fold`,
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
const NEUTRAL_DESCRIPTORS = new Set(["original mix", "original", "extended mix"]);

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

/** A catalogue entry the matcher indexes — a finding's identity + its id. */
export type CatalogueTrack = {
  artists: string[] | string;
  title: string;
  trackId: string;
};

/**
 * Build a matchKey → trackId index over the findings catalogue. An identity shared
 * by MORE than one finding maps to `null` (ambiguous — never guessed), mirroring
 * key_backfill.py's reconcile discipline.
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
