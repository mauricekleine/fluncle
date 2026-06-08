// Tag policy: normalize a list of candidate tags down to recognized drum & bass
// sub-genres. Tags reach Fluncle two ways (see docs/track-lifecycle.md): the
// async enrichment agent's audio-derived suggestion ("auto"), and an admin's
// manual review ("manual"). Both pass through here so what we store stays clean.
//
// Every Fluncle find is drum & bass, so the only informative tag is the *scene
// sub-genre* (neurofunk, liquid funk, jungle, ...). We keep an ALLOW-LIST of
// those and drop everything else — the umbrella genre (drum and bass / dnb,
// which is true of every find), broad/geographic/junk noise, and any off-genre
// stray. A block-list would be whack-a-mole; the sub-genre vocabulary is finite,
// so an allow-list is simpler and precise. Extend SUBGENRES as the scene does.

// Canonical comparison key: lowercase, & -> and, punctuation -> space, collapsed.
function canon(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Drum & bass sub-genres ONLY (canonical keys). Everything else is dropped —
// including adjacent electronic genres that are NOT dnb (dubstep, footwork) and
// parent/umbrella terms (breakbeat, breaks). Keeping this strictly dnb-internal
// is what makes the policy high-precision: a crowd-sourced "dubstep" on a dnb
// track gets dropped rather than stored wrong. Add to this set deliberately, and
// only with genuine dnb sub-genres.
const SUBGENRES = new Set([
  "autonomic",
  "dancefloor",
  "dancefloor dnb",
  "darkstep",
  "deep dnb",
  "drumfunk",
  "drumstep",
  "halftime",
  "half time",
  "hardstep",
  "intelligent dnb",
  "jazzstep",
  "jump up",
  "jumpup",
  "jungle",
  "jungle dnb",
  "liquid",
  "liquid dnb",
  "liquid drum and bass",
  "liquid funk",
  "minimal dnb",
  "neuro",
  "neurofunk",
  "ragga jungle",
  "rollers",
  "sambass",
  "techstep",
]);

const KEEP_CAP = 6;

/**
 * Clean a raw Last.fm tag list into the stored sub-genre tags: keep only
 * recognized drum & bass sub-genres (lowercased, deduped, capped). Returns []
 * when nothing matches — including wrong-page sets from remix/collision pages.
 */
export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const tag of raw) {
    const key = canon(tag);

    if (!SUBGENRES.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    kept.push(tag.trim().toLowerCase());

    if (kept.length >= KEEP_CAP) {
      break;
    }
  }

  return kept;
}
