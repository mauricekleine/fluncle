// THE ENTITY BIO → META DESCRIPTION TRIM.
//
// The graph pages (/artist/<slug>, /label/<slug>) used to reuse ONE templated `description`
// across the whole catalogue ("Every X banger Fluncle has found …") — near-identical on every
// page, which is the duplicate-description SEO weakness. When an entity carries a factual bio
// (the objective, third-person paragraph the page already prints), THAT is the honest, unique
// meta description: the same definitional content a searcher or an answer-engine wants, and it
// is already the Narrator-plain register meta text must stay in (VOICE.md — no first person in
// the meta).
//
// The bio can run 3–4 sentences (≤500 chars); a `<meta name="description">` reads best around
// 155–160. So this trims to 160 at a boundary — never mid-word — preferring a clean sentence
// end and otherwise the last whole word with a trailing ellipsis to signal the cut. The FINAL
// string (ellipsis included) is always ≤160. When the whole bio already fits, it is returned
// verbatim (no ellipsis).

/** The `<meta name="description">` character cap the trim keeps the result within. */
const META_DESCRIPTION_MAX = 160;

/**
 * A complete sentence is only preferred when it carries at least this fraction of the cap, so a
 * bio opening with a very short first sentence ("He is a DJ. …") is not clipped to that stub.
 */
const SENTENCE_END_MIN_FRACTION = 0.6;

/**
 * Trim an entity bio to a ≤160-char meta description.
 *
 * - Whitespace is collapsed to single spaces (a meta description is one line; an authored bio's
 *   line breaks would otherwise leak into the tag).
 * - A bio already within the cap is returned verbatim — no ellipsis.
 * - Otherwise: end on a complete sentence when one lands within the cap and carries enough of
 *   the bio; else cut at the last whole word (never mid-word) and mark the cut with an ellipsis.
 */
export function bioMetaDescription(bio: string): string {
  const normalized = bio.replace(/\s+/gu, " ").trim();

  if (normalized.length <= META_DESCRIPTION_MAX) {
    return normalized;
  }

  const capped = normalized.slice(0, META_DESCRIPTION_MAX);

  // A sentence terminator FOLLOWED by a space marks a complete sentence that fits within the
  // cap. Prefer the last such boundary when it carries enough of the bio — a clean, un-elided
  // full sentence reads best in a SERP snippet.
  const sentenceEnd = Math.max(
    capped.lastIndexOf(". "),
    capped.lastIndexOf("! "),
    capped.lastIndexOf("? "),
  );

  if (sentenceEnd >= META_DESCRIPTION_MAX * SENTENCE_END_MIN_FRACTION) {
    // Include the terminator, drop the trailing space.
    return normalized.slice(0, sentenceEnd + 1);
  }

  // Otherwise cut at the last whole word, leaving one char of room for the ellipsis, and strip
  // any dangling punctuation/space before appending it.
  const room = normalized.slice(0, META_DESCRIPTION_MAX - 1);
  const lastSpace = room.lastIndexOf(" ");
  const head = (lastSpace > 0 ? room.slice(0, lastSpace) : room).replace(/[\s.,;:!?—–-]+$/u, "");

  return `${head}…`;
}
