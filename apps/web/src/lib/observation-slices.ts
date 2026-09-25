export type ObservationWord = { endMs: number; startMs: number; text: string };

export type ObservationSlice = {
  start: number;
  words: ObservationWord[];
};

export type ActiveSlice = {
  activeWordInSlice: number;

  slices: ObservationSlice[];

  sliceIndex: number;
};

const MAX_WORDS_PER_SLICE = 12;
const MIN_WORDS_PER_SLICE = 6;

const SENTENCE_END = /[.!?…]["')\]]*$/;

const PHRASE_BREAK = /[,;:—–]["')\]]*$/;

export function sliceObservationWords(words: ObservationWord[]): ObservationSlice[] {
  const slices: ObservationSlice[] = [];
  let start = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];

    if (!word) {
      continue;
    }

    const count = i - start + 1;
    const atSentenceEnd = SENTENCE_END.test(word.text);

    const atPhraseWindow =
      (count >= MIN_WORDS_PER_SLICE && PHRASE_BREAK.test(word.text)) ||
      count >= MAX_WORDS_PER_SLICE;
    const isLastWord = i === words.length - 1;

    if (atSentenceEnd || atPhraseWindow || isLastWord) {
      slices.push({ start, words: words.slice(start, i + 1) });
      start = i + 1;
    }
  }

  return slices;
}

function activeWordIndex(words: { endMs: number; startMs: number }[], offsetMs: number): number {
  let index = -1;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];

    if (!word || offsetMs < word.startMs) {
      break;
    }

    index = i;
  }

  return index;
}

export function activeSliceForOffset(words: ObservationWord[], offsetMs: number): ActiveSlice {
  const slices = sliceObservationWords(words);

  if (slices.length === 0) {
    return { activeWordInSlice: -1, sliceIndex: 0, slices };
  }

  const flatActive = activeWordIndex(words, offsetMs);

  if (flatActive < 0) {
    return { activeWordInSlice: -1, sliceIndex: 0, slices };
  }

  for (let s = slices.length - 1; s >= 0; s -= 1) {
    const slice = slices[s];

    if (slice && flatActive >= slice.start) {
      return {
        activeWordInSlice: flatActive - slice.start,
        sliceIndex: s,
        slices,
      };
    }
  }

  return { activeWordInSlice: 0, sliceIndex: 0, slices };
}
