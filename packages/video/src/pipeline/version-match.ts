// Version-aware recording matching, shared by the preview resolvers.
//
// A finding's ISRC uniquely identifies the EXACT recording: an original and its
// remix carry DIFFERENT ISRCs. When we have to fall back to an artist+title name
// search (no ISRC, or the ISRC lookup found no preview), the search returns the
// whole release family — the original, every remix, radio/extended edits — and we
// must NOT pick the original when the finding is a remix (or vice-versa).
//
// This mirrors the discipline in apps/web/src/lib/server/discogs.ts: PRESERVE the
// version token (never strip "- X Remix" and boost the bare original), and require
// the finding's version descriptor to AGREE with the candidate before accepting it.

/** Casefold, strip accents, drop bracketed credits, collapse to single spaces. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Any word that marks a track as a specific version rather than the bare title.
const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;
// A third-party / alternate REWORK (not the artist's own original/extended/radio
// cut) — different musical content than the finding, so the WRONG recording.
const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;

/**
 * Strip a trailing version/mix descriptor so a title like "Days Like These -
 * Original Mix" matches a bare "Days Like These". Only strips a tail that actually
 * names a version, so an ordinary "A - B" title is left untouched. Used to compare
 * the BASE titles; the version descriptor itself is compared separately.
 */
export function stripVersionSuffix(title: string): string {
  const parts = title.split(/\s+-\s+/);
  if (parts.length > 1 && VERSION_MARKER.test(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" - ").trim();
  }
  return title.trim();
}

/** True when the title carries a third-party rework marker (remix/VIP/bootleg/…). */
export function isRemix(title: string): boolean {
  return REMIX_MARKER.test(title);
}

/**
 * The version descriptor of a title as a normalized token set: the trailing "- …"
 * segment when it names a version (e.g. "- Calyx & TeeBee Remix" →
 * {calyx, teebee, remix}), or a bracketed "(… Remix)" descriptor. Empty when the
 * title is the bare original. This is what must AGREE between the finding and a
 * candidate so a remix never matches the original.
 */
export function versionTokens(title: string): Set<string> {
  const parts = title.split(/\s+-\s+/);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (parts.length > 1 && VERSION_MARKER.test(tail)) {
    return new Set(normalizeTokens(tail));
  }
  // Bracketed version: "Title (Calyx & TeeBee Remix)". `normalize` drops brackets,
  // so read the descriptor out of the brackets explicitly here.
  const bracketed = /[([]([^)\]]*?)[)\]]/.exec(title);
  if (bracketed?.[1] && VERSION_MARKER.test(bracketed[1])) {
    return new Set(normalizeTokens(bracketed[1]));
  }
  return new Set();
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Stopwords carry no recording identity ("mix"/"the" appear on every remix); the
// remixer name is what disambiguates one remix from another.
const VERSION_STOPWORDS = new Set(["mix", "the", "and", "feat", "ft", "edit", "version", "remix"]);

/**
 * Whether a candidate title is the SAME version as the finding title.
 *
 * The rule (Discogs-style, directional): the finding's version descriptor must
 * AGREE with the candidate's.
 *   - finding is a remix → candidate must be the same remix: it must itself be a
 *     remix, and every meaningful descriptor token of the finding (the remixer
 *     name) must appear in the candidate. The bare original is rejected.
 *   - finding is NOT a remix (original / extended / radio edit) → the candidate
 *     must NOT be a third-party remix; an original matches an original.
 */
export function versionMatches(findingTitle: string, candidateTitle: string): boolean {
  const findingIsRemix = isRemix(findingTitle);
  const candidateIsRemix = isRemix(candidateTitle);

  if (findingIsRemix) {
    if (!candidateIsRemix) {
      return false;
    }
    const want = [...versionTokens(findingTitle)].filter((t) => !VERSION_STOPWORDS.has(t));
    if (want.length === 0) {
      // No remixer name to key on (just "- Remix"); both being remixes is the best
      // we can assert.
      return true;
    }
    const have = versionTokens(candidateTitle);
    for (const token of want) {
      if (!have.has(token)) {
        return false;
      }
    }
    return true;
  }

  // Finding is the original (or the artist's own edit): reject a third-party remix.
  return !candidateIsRemix;
}
