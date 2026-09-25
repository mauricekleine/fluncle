// THE STYLE LEXICON — the words drum & bass fans use for a sound, and how each one is heard.
//
// A fan types "liquid" or taps a "Liquid" chip and means a SOUND, not an artist called Liquid. No
// per-track style clears an open-set gate, so a style here is an ANCHOR-ARTIST SONIC PROBE: the mean
// of a few defining artists' MuQ centroids, used to RE-RANK the catalogue closest first. It is never
// a hard filter and never a label printed on a track; it orders the archive by sound and says which
// artists the sound was built from.
//
// ── WHAT MAY JOIN THIS LIST ──────────────────────────────────────────────────────────────────
// A style earns a place only by the ranking-precision gate in docs/search.md ("A style word is a
// sound"), measured read-only by `scripts/discovery/style_gate.py`: among its probe's labelled
// non-anchor neighbours it must be the majority with 95% confidence at the top 50 and the top 100,
// at a clear lift over its random-sample share. A new style or a changed anchor is re-measured
// before it lands.
//
// ── THE GUARDS ──────────────────────────────────────────────────────────────────────────────
//   - OFFLINE (`search-styles.test.ts`): slugs are unique, aliases never collide across styles,
//     every style carries 3–8 anchors, and every alias parses back to its own style.
//   - IN PRODUCTION (`scripts/post-deploy-probe.ts`): every style's search answers on the sound
//     tier with EVERY anchor resolved to an artist that has a centroid, so an anchor that loses
//     its centroid, is renamed, or is unlisted fails the probe instead of quietly thinning the sound.
//
// Client-safe and pure: the chip rows render from it and `/tracks`'s `validateSearch` parses
// `?sound=` through it, so it reaches no `lib/server/**` (docs/client-bundle.md).

/** One style: its URL slug, the label a chip wears, the words that name it, and its anchors. */
export type SearchStyle = {
  /** Every spelling that names the style on its own (lowercase, single-spaced). */
  aliases: readonly string[];
  /** Fluncle artist SLUGS whose centroids average into the probe, 3–8 of them. */
  anchors: readonly string[];
  /** The chip's label. */
  label: string;
  /** The `?sound=` value. */
  slug: string;
};

export const SEARCH_STYLES = [
  {
    aliases: ["liquid", "liquid funk", "liquid dnb", "liquid drum and bass"],
    anchors: ["calibre", "nu-tone", "logistics", "etherwood", "technimatic", "lsb"],
    label: "Liquid",
    slug: "liquid",
  },
  {
    aliases: ["neuro", "neurofunk", "neuro funk", "neuro dnb", "neuro drum and bass"],
    anchors: ["joe-ford", "nickbee", "black-sun-empire", "audio"],
    label: "Neurofunk",
    slug: "neurofunk",
  },
] as const satisfies readonly SearchStyle[];

/** Every style slug the lexicon holds. */
export type SearchStyleSlug = (typeof SEARCH_STYLES)[number]["slug"];

/** The most anchors one probe averages, and the fewest a style may ship with. */
export const STYLE_ANCHORS_MAX = 8;
export const STYLE_ANCHORS_MIN = 3;

/** The style a `?sound=` value names, or nothing for a slug the lexicon does not hold. */
export function styleBySlug(slug: string | undefined): SearchStyle | undefined {
  if (slug === undefined) {
    return undefined;
  }

  const needle = slug.trim().toLowerCase();

  return SEARCH_STYLES.find((style) => style.slug === needle);
}

/**
 * The words around a style name that do not change what it asks for: "liquid dnb", "some neuro
 * tracks", "jungle tunes". Stripped from the ends only, so a sentence with a style word inside it
 * ("dark neuro with vocals") is not a style query and falls through to the tiers that read
 * sentences (mood words fall through honestly, never guessed at).
 */
const LEADING_FILLER = ["some"];
const TRAILING_FILLER = [
  "bangers",
  "d and b",
  "dnb",
  "drum and bass",
  "drum n bass",
  "drumandbass",
  "music",
  "songs",
  "tracks",
  "tunes",
];

/** Lowercase, `&`/`'n'` spelled out, punctuation to spaces, whitespace collapsed. */
export function normaliseStyleQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]n['’]/g, " n ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripFiller(normalised: string): string {
  let text = normalised;
  let changed = true;

  while (changed) {
    changed = false;

    for (const word of LEADING_FILLER) {
      if (text.startsWith(`${word} `)) {
        text = text.slice(word.length + 1);
        changed = true;
      }
    }

    for (const word of TRAILING_FILLER) {
      if (text.endsWith(` ${word}`)) {
        text = text.slice(0, -(word.length + 1));
        changed = true;
      }
    }
  }

  return text;
}

/**
 * The style a whole query names, or nothing. Exact alias match after the filler is stripped, so
 * "Liquid", "liquid dnb" and "some liquid tunes" all name Liquid, and "liquid sky" does not.
 */
export function parseStyleQuery(query: string): SearchStyle | undefined {
  const text = stripFiller(normaliseStyleQuery(query));

  if (text.length === 0) {
    return undefined;
  }

  return SEARCH_STYLES.find((style) => style.aliases.some((alias) => alias === text));
}

/**
 * The first style a query MENTIONS anywhere, for the empty state's nearest sound: "chilled liquid
 * 174" found nothing, but it said "liquid", so that is the sound to offer. Whole-word match only.
 */
export function styleMentionedIn(query: string): SearchStyle | undefined {
  const text = ` ${normaliseStyleQuery(query)} `;

  return SEARCH_STYLES.find((style) => style.aliases.some((alias) => text.includes(` ${alias} `)));
}

/**
 * "Calibre, Nu:Tone, Logistics and 3 other artists" — the anchors a ranking went by, as a sentence
 * reads them: up to four names, then the rest counted by their noun (the Name It Rule).
 */
export function anchorNames(names: readonly string[], shown = 4): string {
  const head = names.slice(0, shown);
  const rest = names.length - head.length;

  if (rest > 0) {
    return `${head.join(", ")} and ${rest} other ${rest === 1 ? "artist" : "artists"}`;
  }

  if (head.length <= 1) {
    return head[0] ?? "";
  }

  return `${head.slice(0, -1).join(", ")} and ${head.at(-1) ?? ""}`;
}

/** The line over the style chip row on the front door and `/search`: one phrasing for one row. */
export const STYLE_CHIPS_LINE = "Or pick a sound and I’ll line up the tracks closest to it.";

/** `/tracks` ranked by a style's sound. The one place a chip's destination is built. */
export function styleTracksPath(slug: string): string {
  return `/tracks?sound=${encodeURIComponent(slug)}`;
}
