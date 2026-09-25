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

const NEUTRAL_DESCRIPTORS = new Set([
  "original mix",
  "original",
  "extended mix",
  "original version",
]);

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

const DESCRIPTOR_TOKEN_SYNONYMS = new Map([["rmx", "remix"]]);

const ARTIST_SPLIT = /\s*(?:,|&|\/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*/;
const FEAT_INLINE = /\b(?:feat|ft|featuring)\b\.?.*$/i;
const PUNCT = /[^a-z0-9 ]+/g;
const WS = /\s+/g;

function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function fold(text: string): string {
  const folded = stripAccents(text).toLowerCase().replaceAll("&", " and ");

  return folded.replace(PUNCT, " ").replace(WS, " ").trim();
}

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

const SYNONYM_TOKEN_PATTERN = new RegExp(
  `\\b(?:${[...DESCRIPTOR_TOKEN_SYNONYMS.keys()].join("|")})\\b`,
  "gi",
);

const TRAILING_MIX = /[\s._–—-]*mix\s*$/i;

function displaySpelling(matched: string, canonical: string): string {
  const shouted = matched === matched.toUpperCase() && matched !== matched.toLowerCase();

  return shouted
    ? canonical.toUpperCase()
    : canonical.slice(0, 1).toUpperCase() + canonical.slice(1);
}

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

export function canonicalizeSearchTitle(title: string): string {
  const spelled = title.replace(SYNONYM_TOKEN_PATTERN, (match) =>
    displaySpelling(match, DESCRIPTOR_TOKEN_SYNONYMS.get(match.toLowerCase()) ?? match),
  );

  const degrouped = spelled.replace(
    /([([])([^)\]]*)([)\]])/g,
    (_full, open: string, inner: string, close: string) => open + dropRedundantMix(inner) + close,
  );

  return degrouped.replace(/(\s[-–—]\s)(.+)$/, (full, separator: string, suffix: string) =>
    /[([)\]]/.test(suffix) ? full : separator + dropRedundantMix(suffix),
  );
}

export function splitTitle(title: string): { base: string; descriptor: string } {
  let working = title;
  let descriptor = "";

  const groups = [...working.matchAll(/[([]([^)\]]*)[)\]]/g)];

  for (const match of groups.reverse()) {
    const start = match.index;
    const end = start + match[0].length;
    const foldedInner = fold(match[1] ?? "");

    if (!foldedInner) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    if (/^(?:feat|ft|featuring)\b/.test(foldedInner)) {
      working = working.slice(0, start) + working.slice(end);
      continue;
    }

    const tokens = new Set(foldedInner.split(" "));
    const isVersion = [...tokens].some((token) => VERSION_WORDS.has(token));

    if (isVersion && !NEUTRAL_DESCRIPTORS.has(foldedInner)) {
      descriptor = foldedInner;
    }

    working = working.slice(0, start) + working.slice(end);
  }

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

  working = working.replace(FEAT_INLINE, "");

  let base = fold(working);

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

export function matchKey(artists: string[] | string, title: string): string {
  const { base, descriptor } = splitTitle(title);
  const names = [...normalizeArtists(artists)].sort();

  return JSON.stringify([names, base, descriptor]);
}

export function normalizeIsrc(isrc: null | string): null | string {
  const folded = (isrc ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

  return folded.length > 0 ? folded : null;
}

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

export type CatalogueTrack = {
  artists: string[] | string;
  title: string;
  trackId: string;
};

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

export function resolveTrackByText(
  index: Map<string, string | null>,
  artists: string[] | string,
  title: string,
): string | null {
  return index.get(matchKey(artists, title)) ?? null;
}

export type RecordingIdentity = {
  artists: string[] | string;
  isrc: string | null | undefined;
  releaseDate: string | null | undefined;
  spotifyUrl: string | null | undefined;
  title: string;
  trackId: string;
};

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
