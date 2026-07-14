// artifact-diversity.ts — the CORPUS-WIDE sameness harness. The sibling of the note
// echo gate (note.ts), generalised from "does THIS note echo its sonic neighbours" to
// "how much does a WHOLE family of generated artifacts rhyme with itself".
//
// WHY IT EXISTS. Homogenisation — Fluncle's generated artifacts drifting toward a mean —
// has been seen in two families independently (the notes: "shoulders" in 15/61; the
// videos: the same vehicles), which is what makes it a PROPERTY, not a pair of bugs
// (docs/planning/ROADMAP.md § "Homogenisation"). The note work shipped the first
// counter-measure (the vibe-neighbour layer + `gateNoteEcho`) AND the first metric
// (`scoreNoteEcho` + the note-sweep `--dry-run` harness), so the claim stays falsifiable.
// The roadmap's demand is explicit: EVERY generated artifact family wants an equivalent —
// "an anti-sameness effort with no metric is folklore." This is that equivalent for the
// two written families the note harness did not already cover: the spoken OBSERVATIONS
// and the LOGBOOK entries. (Notes reuse `scoreNoteEcho` directly — see the runner.)
//
// ONE DEFINITION OF "SAME". Every measure here is built on the exact primitives the echo
// gate uses (`echoWords`, `contentOverlap`, and `scoreNoteEcho` itself, all imported from
// note.ts). That is deliberate: a diversity number that disagreed with the gate about what
// "overlap" means would be a second, competing definition of sameness, and then neither
// could be trusted. There is one.
//
// THREE MEASURES per family, all cheap, pure, and deterministic — no model judging its
// own work:
//   1. MEAN PAIRWISE OVERLAP — the content-word Jaccard averaged over every unordered
//      pair in the corpus. The single headline number: how alike is the average two
//      artifacts. (The note work's within-region 0.041→0.015 is the same measure at a
//      narrower scope — see the runner's report for how they line up.)
//   2. TOP REPEATED PHRASES / STOCK MOVES — the n-grams (n = 3..6) that recur across
//      MULTIPLE artifacts, ranked. This is the concrete evidence: "drop has a weight to
//      it" appearing in six observations is a stock move, and this surfaces it by name.
//   3. NEAREST-NEIGHBOUR LIFTS — each artifact run through `scoreNoteEcho` against the
//      REST of its family (the whole corpus as its neighbourhood), reporting the ones
//      that would trip the echo gate: who lifts a phrase from whom.

import {
  contentOverlap,
  echoContentWords,
  echoWords,
  type NoteEcho,
  type NoteEchoThresholds,
  NOTE_ECHO_DEFAULTS,
  scoreNoteEcho,
} from "./note";

/** One generated artifact in a family: a stable id (a Log ID, a sector) and its prose. */
export type Artifact = {
  /** The artifact's identity — a finding's Log ID, or a logbook entry's sector label. */
  id: string;
  /** The prose to measure (figure tokens / markdown already stripped by the reader). */
  text: string;
};

/** A phrase (word n-gram) that recurs across the corpus — a candidate "stock move". */
export type PhraseCount = {
  /** How many DISTINCT artifacts the phrase appears in — the sameness signal. */
  docFreq: number;
  /** Total occurrences across the whole corpus (≥ docFreq). */
  count: number;
  /** Word length of the n-gram. */
  n: number;
  /** The phrase itself, as a lowercased space-joined word run. */
  phrase: string;
};

/** A single content word and how much of the corpus repeats it — the "shoulders" measure. */
export type WordCount = {
  /** How many DISTINCT artifacts contain the word at least once. */
  docFreq: number;
  /** The content word (a note's bodily-image vocabulary is small and recurs). */
  word: string;
};

/** One artifact's worst echo against the rest of its family. */
export type NeighbourLift = {
  /** The echoing artifact's id. */
  id: string;
  /** Its worst neighbour + the lifted phrase / overlap (from `scoreNoteEcho`). */
  echo: NoteEcho;
};

/** The full diversity reading for one artifact family. */
export type FamilyDiversity = {
  /** The family's name, for the report ("observations", "logbook"). */
  family: string;
  /** Artifacts with non-empty prose (the denominator for every measure). */
  size: number;
  /** Mean content-word Jaccard over all unordered pairs (0 = all disjoint, 1 = identical). */
  meanPairwiseOverlap: number;
  /** The single most-alike pair, for the report's "worst offender" line. */
  maxPairwiseOverlap: number;
  /** The ids of that most-alike pair ([] when the family has fewer than two artifacts). */
  maxPair: string[];
  /** The top repeated phrases (docFreq ≥ 2), ranked, capped at the requested topK. */
  topPhrases: PhraseCount[];
  /** The most-widespread single content words (the "shoulders in N of M" signal), top 8. */
  topWords: WordCount[];
  /** Per-artifact worst echoes that would trip the gate, worst-first. */
  neighbourLifts: NeighbourLift[];
  /** How many artifacts echo the rest of the family at the given thresholds. */
  echoingCount: number;
};

/** Options for the phrase / n-gram scan. */
export type PhraseOptions = {
  /** Smallest n-gram length (default 3). */
  minN: number;
  /** Largest n-gram length (default 6). */
  maxN: number;
  /** How many ranked phrases to return (default 10). */
  topK: number;
  /** Minimum distinct-artifact frequency to count as a stock move (default 2). */
  minDocFreq: number;
};

export const PHRASE_DEFAULTS: PhraseOptions = {
  maxN: 6,
  minDocFreq: 2,
  minN: 3,
  topK: 10,
};

/**
 * Mean (and max) content-word Jaccard overlap over every unordered pair in the corpus.
 * The headline diversity number: the average sameness of two randomly-drawn artifacts.
 * O(n²) in the corpus size — fine for an offline operator harness over a few hundred
 * artifacts; it is never on a request path.
 */
export function meanPairwiseOverlap(artifacts: readonly Artifact[]): {
  mean: number;
  max: number;
  maxPair: string[];
} {
  const texts = artifacts.filter((artifact) => artifact.text.trim().length > 0);

  if (texts.length < 2) {
    return { max: 0, maxPair: [], mean: 0 };
  }

  let sum = 0;
  let pairs = 0;
  let max = 0;
  let maxPair: string[] = [];

  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const left = texts[i];
      const right = texts[j];

      if (!left || !right) {
        continue;
      }

      const overlap = contentOverlap(left.text, right.text);

      sum += overlap;
      pairs += 1;

      if (overlap > max) {
        max = overlap;
        maxPair = [left.id, right.id];
      }
    }
  }

  return { max, maxPair, mean: pairs === 0 ? 0 : sum / pairs };
}

/** Count every n-gram of the given length across a corpus of word streams. */
function countNgrams(
  wordStreams: readonly string[][],
  n: number,
): Map<string, { count: number; docFreq: number }> {
  const totals = new Map<string, { count: number; docFreq: number }>();

  for (const words of wordStreams) {
    // docFreq counts an artifact ONCE however many times it repeats the phrase, so a
    // phrase said twice in one entry doesn't masquerade as a cross-corpus stock move.
    const seenInDoc = new Set<string>();

    for (let i = 0; i + n <= words.length; i += 1) {
      const phrase = words.slice(i, i + n).join(" ");
      const entry = totals.get(phrase) ?? { count: 0, docFreq: 0 };

      entry.count += 1;

      if (!seenInDoc.has(phrase)) {
        entry.docFreq += 1;
        seenInDoc.add(phrase);
      }

      totals.set(phrase, entry);
    }
  }

  return totals;
}

/**
 * The top repeated phrases (n-grams, n = minN..maxN) across a family — the concrete
 * "stock moves". A phrase counts only when it appears in at least `minDocFreq` DISTINCT
 * artifacts (a phrase repeated inside one artifact is that artifact's own cadence, not a
 * family-wide tic).
 *
 * Ranked by distinct-artifact frequency first (the sameness signal), then by length
 * (a longer shared run is a more specific, more damning stock move), then by raw count.
 *
 * NESTED SUB-PHRASE SUPPRESSION. A 6-gram stock move drags its 3/4/5-gram sub-runs along
 * with it; listing all of them would bury the ten slots in noise. So a shorter phrase is
 * suppressed when it is a contiguous sub-run of an already-kept longer phrase AND appears
 * in no MORE artifacts than that longer one — i.e. it never occurs on its own. A shorter
 * phrase that is genuinely more widespread than its longer parent survives, because then
 * it IS a distinct, more-common move.
 */
export function topPhrases(
  artifacts: readonly Artifact[],
  options: PhraseOptions = PHRASE_DEFAULTS,
): PhraseCount[] {
  const streams = artifacts
    .map((artifact) => echoWords(artifact.text))
    .filter((words) => words.length > 0);

  const all: PhraseCount[] = [];

  for (let n = options.minN; n <= options.maxN; n += 1) {
    for (const [phrase, { count, docFreq }] of countNgrams(streams, n)) {
      if (docFreq >= options.minDocFreq) {
        all.push({ count, docFreq, n, phrase });
      }
    }
  }

  // Severity ordering: distinct-artifact frequency dominates, then length, then count.
  all.sort((a, b) => b.docFreq - a.docFreq || b.n - a.n || b.count - a.count);

  const kept: PhraseCount[] = [];

  for (const candidate of all) {
    const subsumed = kept.some(
      (keep) =>
        keep.n > candidate.n &&
        keep.docFreq >= candidate.docFreq &&
        keep.phrase.includes(candidate.phrase),
    );

    if (!subsumed) {
      kept.push(candidate);
    }

    if (kept.length >= options.topK) {
      break;
    }
  }

  return kept;
}

/**
 * The most-widespread single content words across a family — the measure the roadmap's
 * own headline evidence uses ("shoulders" in 15 of 61 notes). Counts DISTINCT artifacts,
 * so a word said thrice in one entry still counts once, and ranks by that document
 * frequency. Function words are already stripped (`echoContentWords`), so what surfaces is
 * the vocabulary of imagery the family leans on — the small stock of bodily/sensory words
 * a drifting voice reaches for again and again.
 */
export function topWords(artifacts: readonly Artifact[], topK = 8): WordCount[] {
  const docFreq = new Map<string, number>();

  for (const artifact of artifacts) {
    if (!artifact.text.trim()) {
      continue;
    }

    for (const word of new Set(echoContentWords(artifact.text))) {
      docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
    }
  }

  return [...docFreq.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([word, freq]) => ({ docFreq: freq, word }));
}

/**
 * Run every artifact through `scoreNoteEcho` against the REST of its family — the whole
 * corpus as its neighbourhood — and return the ones that would trip the echo gate,
 * worst-first. This is the note gate's exact judgement, applied corpus-wide rather than to
 * one candidate: who in this family lifts a phrase from (or reuses the words of) whom.
 */
export function nearestNeighbourLifts(
  artifacts: readonly Artifact[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): NeighbourLift[] {
  const texts = artifacts.filter((artifact) => artifact.text.trim().length > 0);
  const lifts: NeighbourLift[] = [];

  for (const artifact of texts) {
    const neighbours = texts
      .filter((other) => other.id !== artifact.id)
      .map((other) => ({ logId: other.id, note: other.text }));

    const echo = scoreNoteEcho(artifact.text, neighbours, thresholds);

    if (echo.echoes) {
      lifts.push({ echo, id: artifact.id });
    }
  }

  // Worst-first: a lifted phrase (longer wins) outranks a bare overlap, matching the
  // gate's own severity ordering.
  lifts.sort((a, b) => {
    const severity = (lift: NeighbourLift) =>
      lift.echo.phrase ? 1 + lift.echo.phrase.split(" ").length : lift.echo.overlap;

    return severity(b) - severity(a);
  });

  return lifts;
}

/**
 * The full diversity reading for one family: the three measures bundled. Pure — hand it a
 * corpus (already read off the DB and cleaned), get a report struct back.
 */
export function measureFamily(
  family: string,
  artifacts: readonly Artifact[],
  options: {
    phrase?: PhraseOptions;
    thresholds?: NoteEchoThresholds;
  } = {},
): FamilyDiversity {
  const populated = artifacts.filter((artifact) => artifact.text.trim().length > 0);
  const pairwise = meanPairwiseOverlap(populated);
  const lifts = nearestNeighbourLifts(populated, options.thresholds);

  return {
    echoingCount: lifts.length,
    family,
    maxPair: pairwise.maxPair,
    maxPairwiseOverlap: pairwise.max,
    meanPairwiseOverlap: pairwise.mean,
    neighbourLifts: lifts,
    size: populated.length,
    topPhrases: topPhrases(populated, options.phrase ?? PHRASE_DEFAULTS),
    topWords: topWords(populated),
  };
}

// ── The REGISTER cuts (openers / closers / crutch words) ─────────────────────────────
//
// Mean overlap and phrase lifts catch a WHOLESALE echo, but the observations' worst
// homogenisation is a REGISTER tic the whole-corpus mean barely moves: the closer is a
// formula ("…enjoy cosmonauts" as the last words of 32/61), the opener is a register
// (34/61 start on "I"/"This one"), and a crutch word recurs almost corpus-wide ("hope" in
// 51/61). These are the cuts the 2026-07-14 audit made by hand; this makes them a function,
// so "did the counter-measure break the formula?" is a number, not an eyeball. Pure and
// deterministic, over the same `echoWords` stream the gate uses.

/** One recurring edge phrase (an opener or a closer) and how many artifacts share it. */
export type EdgePhrase = {
  /** How many DISTINCT artifacts open/close on exactly this word run. */
  docFreq: number;
  /** The lowercased word run (first-N or last-N words of the artifact). */
  phrase: string;
};

/** One tracked crutch word and how many artifacts reach for it (the "hope in 51/61" cut). */
export type CrutchWord = {
  /** How many DISTINCT artifacts contain the word at least once. */
  docFreq: number;
  word: string;
};

/** The register reading for one family: how templated its openers, closers, and reflexes are. */
export type RegisterStats = {
  /** The most common CLOSERS (last-N words), ranked by how many artifacts share them. */
  closers: EdgePhrase[];
  /** Tracked crutch words and their document frequency, in the order requested. */
  crutches: CrutchWord[];
  /** The single most common OPENING WORD and its share (the "34/61 start on I" cut). */
  openingWords: CrutchWord[];
  /** The most common OPENERS (first-N words), ranked by how many artifacts share them. */
  openers: EdgePhrase[];
  /** Artifacts with non-empty prose (the denominator). */
  size: number;
};

/** Rank the first-N (or last-N) word runs by how many distinct artifacts share them. */
function edgePhrases(
  streams: readonly string[][],
  edgeWords: number,
  fromEnd: boolean,
  topK: number,
): EdgePhrase[] {
  const docFreq = new Map<string, number>();

  for (const words of streams) {
    if (words.length === 0) {
      continue;
    }

    const edge = fromEnd
      ? words.slice(Math.max(0, words.length - edgeWords))
      : words.slice(0, edgeWords);
    const phrase = edge.join(" ");

    docFreq.set(phrase, (docFreq.get(phrase) ?? 0) + 1);
  }

  return [...docFreq.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([phrase, freq]) => ({ docFreq: freq, phrase }));
}

/**
 * The register reading for a family: how templated its openers and closers are, plus the
 * document frequency of a caller-supplied list of crutch words. `edgeWords` is how many words
 * count as the opener/closer (3 catches "…enjoy cosmonauts" and "this one crept up"); the
 * opening-WORD histogram is separate because the audit's headline opener cut is a single first
 * word ("I"). Everything reads the same `echoWords` stream the echo gate uses.
 */
export function measureRegisters(
  artifacts: readonly Artifact[],
  options: { crutchWords?: readonly string[]; edgeWords?: number; topK?: number } = {},
): RegisterStats {
  const { crutchWords = [], edgeWords = 3, topK = 8 } = options;
  const populated = artifacts.filter((artifact) => artifact.text.trim().length > 0);
  const streams = populated.map((artifact) => echoWords(artifact.text)).filter((w) => w.length > 0);

  // Opening-word histogram — the single first word, the audit's headline opener cut.
  const firstWord = new Map<string, number>();

  for (const words of streams) {
    const first = words[0];

    if (first) {
      firstWord.set(first, (firstWord.get(first) ?? 0) + 1);
    }
  }

  const openingWords = [...firstWord.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([word, freq]) => ({ docFreq: freq, word }));

  // Crutch words — document frequency of each tracked reflex, in the order asked (a stable
  // report, so a re-measure lines up column-for-column against the last one).
  const crutches = crutchWords.map((word) => {
    const needle = word.toLowerCase();
    let docFreq = 0;

    for (const words of streams) {
      if (words.includes(needle)) {
        docFreq += 1;
      }
    }

    return { docFreq, word: needle };
  });

  return {
    closers: edgePhrases(streams, edgeWords, true, topK),
    crutches,
    openers: edgePhrases(streams, edgeWords, false, topK),
    openingWords,
    size: populated.length,
  };
}

/**
 * Strip the logbook body's non-prose furniture before measuring: the `[[<logId>]]` figure
 * tokens (each on its own line, swapped for a poster image by the renderer) and markdown
 * emphasis. `echoWords` already drops punctuation, but a raw `[[004.6.8K]]` would inject
 * "004 6 8k" word-noise into the phrase scan, so it is removed here at the source.
 */
export function stripLogbookProse(body: string): string {
  return body
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/[*_#>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
