// Version-aware recording matching for the preview-archive backfill.
//
// A finding's ISRC uniquely identifies the EXACT recording: an original and its
// remix carry DIFFERENT ISRCs. The archive backfill resolves Deezer by ISRC first,
// but its fuzzy fallbacks (Deezer search / iTunes) returned the FIRST hit with no
// version check — so a remix finding could archive the original's audio, which is
// then served as confidence-1 "exact" to every future render (the worst blast
// radius). These helpers gate the fuzzy fallbacks the same way the render's
// resolve-preview and apps/web's discogs resolver do: the candidate's version
// descriptor must AGREE with the finding's, and the base title must actually match.

/** Casefold, strip accents, drop bracketed credits, collapse to single spaces. */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const VERSION_MARKER =
  /\b(mix|edit|version|remix|dub|vip|bootleg|rework|re-?edit|flip|refix|remaster(?:ed)?|instrumental)\b/i;
const REMIX_MARKER = /\b(remix|bootleg|vip|rework|re-?edit|flip|refix)\b/i;

const VERSION_STOPWORDS = new Set(["mix", "the", "and", "feat", "ft", "edit", "version", "remix"]);

/** True when the title carries a third-party rework marker (remix/VIP/bootleg/…). */
export function isRemix(title: string): boolean {
  return REMIX_MARKER.test(title);
}

/** Strip a trailing version/mix descriptor so base titles compare equal. */
export function stripVersionSuffix(title: string): string {
  const parts = title.split(/\s+-\s+/);
  if (parts.length > 1 && VERSION_MARKER.test(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" - ").trim();
  }
  return title.trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** The version descriptor (trailing "- …" or bracketed "(… Remix)") as a token set. */
function versionTokens(title: string): Set<string> {
  const parts = title.split(/\s+-\s+/);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
  if (parts.length > 1 && VERSION_MARKER.test(tail)) {
    return new Set(tokenize(tail));
  }
  const bracketed = /[([]([^)\]]*?)[)\]]/.exec(title);
  if (bracketed?.[1] && VERSION_MARKER.test(bracketed[1])) {
    return new Set(tokenize(bracketed[1]));
  }
  return new Set();
}

/**
 * Whether a candidate title is the SAME version as the finding (directional, like
 * the render's resolve-preview): a remix finding requires the same remix (the
 * remixer name must appear and the candidate must itself be a remix); an original
 * rejects any third-party remix.
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

  return !candidateIsRemix;
}

/** True when every base-title token of the finding appears in the candidate's. */
export function baseTitleMatches(findingTitle: string, candidateTitle: string): boolean {
  const want = new Set(tokenize(stripVersionSuffix(findingTitle)));
  const have = new Set(tokenize(stripVersionSuffix(candidateTitle)));
  if (want.size === 0) {
    return false;
  }
  for (const token of want) {
    if (!have.has(token)) {
      return false;
    }
  }
  return true;
}
