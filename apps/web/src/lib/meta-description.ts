const META_DESCRIPTION_MAX = 160;

const SENTENCE_END_MIN_FRACTION = 0.6;

export function bioMetaDescription(bio: string): string {
  const normalized = bio.replace(/\s+/gu, " ").trim();

  if (normalized.length <= META_DESCRIPTION_MAX) {
    return normalized;
  }

  const capped = normalized.slice(0, META_DESCRIPTION_MAX);

  const sentenceEnd = Math.max(
    capped.lastIndexOf(". "),
    capped.lastIndexOf("! "),
    capped.lastIndexOf("? "),
  );

  if (sentenceEnd >= META_DESCRIPTION_MAX * SENTENCE_END_MIN_FRACTION) {
    return normalized.slice(0, sentenceEnd + 1);
  }

  const room = normalized.slice(0, META_DESCRIPTION_MAX - 1);
  const lastSpace = room.lastIndexOf(" ");
  const head = (lastSpace > 0 ? room.slice(0, lastSpace) : room).replace(/[\s.,;:!?—–-]+$/u, "");

  return `${head}…`;
}
