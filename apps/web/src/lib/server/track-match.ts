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
//   - that descriptor is canonicalized to ONE spelling before it becomes identity
//     (`rmx`→`remix`, a redundant trailing `mix` dropped), so two platforms spelling
//     the same version differently still resolve to the same recording;
//   - anything ambiguous resolves to NOTHING (honest silence over a wrong link).
// `canonicalizeSearchTitle` is the retrieval-side twin of that descriptor fold: the same two rules
// applied to the RAW title the anchor rungs SEARCH with, so the spelling we ask for is the spelling
// the platforms index — a gate that forgives a spelling the query never asks for judges nothing.

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

// The subset of VERSION_WORDS strong enough to mark a version even BARE at the end of a
// title — no parens, no dash ("Paint It Black VIP" vs Spotify's "Paint It Black (Vip)";
// an anchor false-miss). Deliberately narrow: `dub`, `mix`,
// `version`, `edit`, `flip`, and `extended` are genuine title-final words all over
// jungle/DnB ("… Dub" titles), and folding one of those off a real title would let two
// different recordings match — a wrong anchor is worse than a missed one.
const BARE_TRAILING_VERSION_WORDS = new Set([
  "bootleg",
  "instrumental",
  "refix",
  "remaster",
  "remix",
  "rework",
  "rmx",
  "vip",
]);

// Token spellings that name the SAME version word. Two platforms writing one recording
// two ways ("(Air.K & Cephei rmx)" vs "(Air.K & Cephei Remix)") is an anchor false-miss,
// so the descriptor's tokens are rewritten to one spelling
// before it becomes identity. Deliberately tiny — only spellings observed in the wild
// go in; a new synonym is a one-line addition here — and BOTH sides of the fold read this
// one map: `canonicalizeDescriptor` (identity) and `canonicalizeSearchTitle` (retrieval).
// Mirrored by `_DESCRIPTOR_TOKEN_SYNONYMS` in
// packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py — keep in lockstep.
const DESCRIPTOR_TOKEN_SYNONYMS = new Map([["rmx", "remix"]]);

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
 * One spelling for one version. Two platforms name the SAME version two ways, and an opaque
 * descriptor makes those permanently un-anchorable — so once a descriptor IS the identity, fold
 * its synonym spellings together:
 *   - a token synonym ({@link DESCRIPTOR_TOKEN_SYNONYMS}): `rmx` → `remix`;
 *   - a redundant trailing `mix` after a version word: `instrumental mix` → `instrumental`,
 *     `dub mix` → `dub` (the `mix` adds nothing the preceding word did not already say).
 *
 * Runs LAST, on a descriptor `splitTitle` has already accepted — so the {@link NEUTRAL_DESCRIPTORS}
 * check still reads the raw folded spelling and "Original Mix" keeps folding to the original rather
 * than becoming a distinguishing "original". A bare `mix` is left alone (dropping it would empty
 * the descriptor), and a non-version word before the `mix` is left alone too ("dj mix" stays).
 *
 * Mirrored by `_canonicalize_descriptor` in
 * packages/skills/fluncle-rekordbox-sync/scripts/rekordbox_sync.py — keep the two in lockstep.
 * {@link canonicalizeSearchTitle} is the RETRIEVAL-side twin of these same two rules — the two
 * move together, because a gate that forgives a spelling the query never asks for is a gate with
 * nothing to judge.
 */
function canonicalizeDescriptor(descriptor: string): string {
  if (!descriptor) {
    return "";
  }

  const tokens = descriptor
    .split(" ")
    .map((token) => DESCRIPTOR_TOKEN_SYNONYMS.get(token) ?? token);

  if (tokens.length > 1 && tokens.at(-1) === "mix" && VERSION_WORDS.has(tokens.at(-2) ?? "")) {
    tokens.pop();
  }

  return tokens.join(" ");
}

// One alternation over every synonym spelling, derived from the map itself so a new entry needs no
// second edit here. Word-boundaried and case-insensitive: only the whole token is rewritten.
const SYNONYM_TOKEN_PATTERN = new RegExp(
  `\\b(?:${[...DESCRIPTOR_TOKEN_SYNONYMS.keys()].join("|")})\\b`,
  "gi",
);

// A redundant trailing `mix` on a RAW descriptor, with whatever separator (space, dot, dash,
// underscore) precedes it — the raw-string counterpart of `canonicalizeDescriptor`'s `tokens.pop()`.
const TRAILING_MIX = /[\s._–—-]*mix\s*$/i;

/** The canonical spelling in a raw title's own register: ALL-CAPS stays shouted, anything else Titles. */
function displaySpelling(matched: string, canonical: string): string {
  const shouted = matched === matched.toUpperCase() && matched !== matched.toLowerCase();

  return shouted
    ? canonical.toUpperCase()
    : canonical.slice(0, 1).toUpperCase() + canonical.slice(1);
}

/**
 * Drop a redundant trailing `mix` from ONE raw version descriptor, under exactly the guards
 * {@link canonicalizeDescriptor} applies to the folded one: never when dropping it would empty the
 * descriptor ("(Mix)" stays), never after a non-version word ("(Nu:Tone DJ Mix)" stays), and never on
 * a {@link NEUTRAL_DESCRIPTORS} spelling ("(Extended Mix)" stays — `splitTitle` never lets that reach
 * the fold, so the query must not touch it either). Only the `mix` leaves; the rest of the raw text —
 * its casing, its dots, its ampersands — is returned untouched.
 */
function dropRedundantMix(descriptor: string): string {
  const folded = fold(descriptor);
  const tokens = folded ? folded.split(" ") : [];

  const redundant =
    tokens.length > 1 &&
    tokens.at(-1) === "mix" &&
    VERSION_WORDS.has(tokens.at(-2) ?? "") &&
    !NEUTRAL_DESCRIPTORS.has(folded);

  return redundant ? descriptor.replace(TRAILING_MIX, "") : descriptor;
}

/**
 * THE QUERY SPELLING — the retrieval-side twin of {@link canonicalizeDescriptor}. The identity fold
 * forgives two platforms spelling one version two ways, but it only ever runs on a candidate we
 * already HAVE: if the search we sent was spelled the row's way and the platform indexes the other
 * way, the gate is handed nothing to judge and the row misses forever (Minos
 * "Feels Like Before (Air.K & Cephei rmx)" and Klute "Part of Me (instrumental mix)", both
 * retrievable under the canonical spelling, both unreachable under the raw one).
 *
 * So the SAME two rules run on the RAW title we ASK with — a synonym token
 * ({@link DESCRIPTOR_TOKEN_SYNONYMS}: `rmx` → `Remix`) and a redundant trailing `mix` inside a
 * version parenthetical / dash-suffix ({@link dropRedundantMix}) — and nothing else. This is NOT the
 * folded key: the title keeps its real casing, its dots, its ampersands, because that is the string
 * platform search relevance is tuned for. A title with neither pattern comes back byte-identical.
 *
 * Every anchor rung's query goes through here — the Worker's own Spotify search and the box's Apify
 * sweep via `anchorSearchQuery` (anchor.ts), the pre-anchor ISRC recovery via `searchDeezerCandidates`
 * (deezer.ts) — so one spelling is asked everywhere. Verification is unchanged: the candidates that
 * come back are still judged against the row's RAW title through `matchKey`.
 */
export function canonicalizeSearchTitle(title: string): string {
  const spelled = title.replace(SYNONYM_TOKEN_PATTERN, (match) =>
    displaySpelling(match, DESCRIPTOR_TOKEN_SYNONYMS.get(match.toLowerCase()) ?? match),
  );

  // Parenthetical / bracket groups — the descriptor's usual home, rewritten in place.
  const degrouped = spelled.replace(
    /([([])([^)\]]*)([)\]])/g,
    (_full, open: string, inner: string, close: string) => open + dropRedundantMix(inner) + close,
  );

  // A dash-suffixed version ("Song - Instrumental Mix"), the other form `splitTitle` accepts. Skipped
  // when the suffix carries a bracket, since that group was already handled above.
  return degrouped.replace(/(\s[-–—]\s)(.+)$/, (full, separator: string, suffix: string) =>
    /[([)\]]/.test(suffix) ? full : separator + dropRedundantMix(suffix),
  );
}

/**
 * `(base title, version descriptor)` — the base with feat./mix suffixes removed,
 * plus the distinguishing version descriptor ("" for the original), canonicalized to
 * one spelling by {@link canonicalizeDescriptor}.
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

  let base = fold(working);

  // A BARE trailing strong version word ("Paint It Black VIP") is the same version the
  // parenthesized spelling names — fold it into the descriptor so the two forms share a
  // key. Only when no descriptor was found yet, and only when a non-empty base remains
  // (a title that IS just "VIP" stays a title).
  if (!descriptor) {
    const tokens = base.split(" ");
    const last = tokens.at(-1) ?? "";

    if (tokens.length > 1 && BARE_TRAILING_VERSION_WORDS.has(last)) {
      descriptor = last;
      base = tokens.slice(0, -1).join(" ");
    }
  }

  return { base, descriptor: canonicalizeDescriptor(descriptor) };
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
 * An ISRC folded for identity comparison. ISRCs are case-insensitive alphanumeric codes that
 * carry stray hyphens/spaces in the wild; blank values deliberately have no key.
 */
export function normalizeIsrc(isrc: null | string): null | string {
  const folded = (isrc ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

  return folded.length > 0 ? folded : null;
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
