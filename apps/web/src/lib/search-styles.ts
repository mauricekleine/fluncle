export type SearchStyle = {
  aliases: readonly string[];
  anchors: readonly string[];
  label: string;
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

export type SearchStyleSlug = (typeof SEARCH_STYLES)[number]["slug"];

export const STYLE_ANCHORS_MAX = 8;
export const STYLE_ANCHORS_MIN = 3;

export function styleBySlug(slug: string | undefined): SearchStyle | undefined {
  if (slug === undefined) {
    return undefined;
  }

  const needle = slug.trim().toLowerCase();

  return SEARCH_STYLES.find((style) => style.slug === needle);
}

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

export function parseStyleQuery(query: string): SearchStyle | undefined {
  const text = stripFiller(normaliseStyleQuery(query));

  if (text.length === 0) {
    return undefined;
  }

  return SEARCH_STYLES.find((style) => style.aliases.some((alias) => alias === text));
}

export function styleMentionedIn(query: string): SearchStyle | undefined {
  const text = ` ${normaliseStyleQuery(query)} `;

  return SEARCH_STYLES.find((style) => style.aliases.some((alias) => text.includes(` ${alias} `)));
}

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

export const STYLE_CHIPS_LINE = "Or pick a sound and I’ll line up the tracks closest to it.";

export function styleTracksPath(slug: string): string {
  return `/tracks?sound=${encodeURIComponent(slug)}`;
}
