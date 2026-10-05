export const META_DESCRIPTION_MAX = 160;

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

const ABBREVIATION_END = /(?:^|[\s.(])(?:\p{L}|Dr|Jr|Mr|Mrs|Ms|Mt|No|Sr|St|Vol|feat|ft|vs)\.$/iu;

function splitSentences(text: string): string[] {
  const pieces = text
    .replace(/\s+/gu, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=\p{Lu}|\p{N})/u);

  return pieces.reduce<string[]>((sentences, piece) => {
    const previous = sentences.at(-1);

    if (previous !== undefined && ABBREVIATION_END.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${piece}`;
    } else {
      sentences.push(piece);
    }

    return sentences;
  }, []);
}

export function leadingSentences(text: string, room: number): string | undefined {
  const sentences = splitSentences(text);
  let lead = "";

  for (const sentence of sentences) {
    const next = lead === "" ? sentence : `${lead} ${sentence}`;

    if (next.length > room || !/[.!?]$/u.test(sentence)) {
      break;
    }

    lead = next;
  }

  return lead === "" ? undefined : lead;
}
