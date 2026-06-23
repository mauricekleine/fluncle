// Observation slicing for the radio's center-stage captions (radio.tsx). The
// observation script is shown ONE slice at a time, big and centered — Fluncle
// narrating live — not the whole transcript as a bottom-anchored subtitle strip.
// This module owns the PURE math: given the word-level alignment and the current
// shared-clock offset, it splits the script into sequential slices and reports
// which slice is live and which word inside it is lit. Kept pure + unit-tested
// (observation-slices.test.ts) because the slicing + active-word logic is the
// load-bearing part of the read and must be verifiable without driving the UI.

export type ObservationWord = { endMs: number; startMs: number; text: string };

// A slice is a contiguous run of words shown together on screen. `start` is the
// index of its first word in the flat `words[]`; `words` is that run.
export type ObservationSlice = {
  // The index in the flat word list of this slice's FIRST word — lets the caller
  // map a flat active-word index onto an in-slice index without re-walking.
  start: number;
  words: ObservationWord[];
};

export type ActiveSlice = {
  // -1 before the first word is spoken (nothing lit yet); otherwise the index of
  // the word WITHIN the active slice that is currently lit.
  activeWordInSlice: number;
  // The full ordered list of slices (stable for the whole finding).
  slices: ObservationSlice[];
  // Which slice is on screen. Defaults to 0 before the first word (so the opening
  // line is already staged), then tracks the spoken word.
  sliceIndex: number;
};

// Slicing choice (documented per the brief):
//   A slice is a NATURAL NARRATION UNIT — a sentence. We close a slice on a word
//   that ends in sentence-terminal punctuation (. ! ? … or their quoted/bracketed
//   variants). Fluncle's voice never uses "!", but we treat all terminals for
//   robustness. A sentence is the unit a listener parses as one thought, so it is
//   the right thing to swap on screen.
//
//   But a long sentence would overflow when set big and centered on a phone, so a
//   sentence is FURTHER chunked into bounded phrase windows: at most
//   MAX_WORDS_PER_SLICE words, preferring to break on a soft phrase boundary
//   (comma / dash / semicolon / colon) at or past MIN_WORDS_PER_SLICE so the
//   window reads as a phrase, not an arbitrary cut. If no soft boundary is in
//   range we hard-cut at the max. Either way a slice is always small enough to sit
//   comfortably centered at the big size.
const MAX_WORDS_PER_SLICE = 12;
const MIN_WORDS_PER_SLICE = 6;

// A word that ENDS a sentence: trailing terminal punctuation, allowing a closing
// quote/paren/bracket after it (e.g. `home."`, `there?`, `wait…`).
const SENTENCE_END = /[.!?…]["')\]]*$/;
// A word that ends a PHRASE: a soft internal break we may chunk a long sentence on
// — comma, semicolon, colon, or a dash (em/en). A bare hyphen is deliberately NOT
// here: it joins a compound (`drum-`) rather than ending a phrase, so breaking on
// it would split mid-word.
const PHRASE_BREAK = /[,;:—–]["')\]]*$/;

/**
 * Split the flat word list into sequential, screen-friendly slices (sentence
 * units, long sentences chunked into bounded phrase windows). Pure; deterministic.
 */
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
    // Within a sentence, only consider a soft break once we've reached a readable
    // minimum, and force one at the hard cap so a slice never overflows.
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

// The flat active-word index for an offset (ms into the observation): the LAST
// word whose window has started. Between words (a gap/pause) the last spoken word
// stays lit rather than flickering off, so the read never strobes. -1 before the
// first word. Linear scan is fine — observations are ~40 words. (Mirrors the
// previous full-transcript activeWordIndex so the per-word highlight is identical.)
export function activeWordIndex(
  words: { endMs: number; startMs: number }[],
  offsetMs: number,
): number {
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

/**
 * Given the word alignment and the current shared-clock offset (ms into the
 * observation), return the ordered slices, which slice is on screen, and which
 * word within it is lit.
 *
 * Advance is slice-by-slice and falls straight out of the active-word math: when
 * the spoken word reaches a slice's LAST word, the next tick's word is the FIRST
 * word of the next slice, so `sliceIndex` jumps and `activeWordInSlice` resets to
 * 0 — a clean swap with the new slice's opening word already lit.
 *
 * Edge cases: before the first word, hold slice 0 with nothing lit
 * (activeWordInSlice -1) so the opening line is staged. After the last word, hold
 * the final slice with its last word lit. Gaps keep the last word lit (above).
 */
export function activeSliceForOffset(words: ObservationWord[], offsetMs: number): ActiveSlice {
  const slices = sliceObservationWords(words);

  if (slices.length === 0) {
    return { activeWordInSlice: -1, sliceIndex: 0, slices };
  }

  const flatActive = activeWordIndex(words, offsetMs);

  // Before the first word is spoken: stage the opening slice, nothing lit yet.
  if (flatActive < 0) {
    return { activeWordInSlice: -1, sliceIndex: 0, slices };
  }

  // The active slice is the one whose flat range contains the active word. A word
  // sits in slice s when start[s] <= flatActive < start[s+1]; the boundary word
  // (a slice's last word) therefore belongs to THAT slice, and the jump to the
  // next slice happens on the next word — exactly the brief's clean swap.
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

  // Unreachable (flatActive >= 0 always lands in slice 0 at minimum), but keep a
  // total return so the function is exhaustive without a non-null assertion.
  return { activeWordInSlice: 0, sliceIndex: 0, slices };
}
