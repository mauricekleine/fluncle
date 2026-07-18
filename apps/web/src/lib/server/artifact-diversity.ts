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

// The worn-through Texture descriptors the 2026-07-14 audit named
// (docs/planning/homogenisation-evidence.md): the recycled palette the `context_distil`
// prompt now warns against. Tracked in a fixed order so a re-measure lines up column-for-
// column against the audit's numbers (rolling 34, breakbeats 27, liquid 25, introspective
// 25, atmospheric 19 over the 61 context notes).
export const WORN_TEXTURE_WORDS = [
  "rolling",
  "liquid",
  "introspective",
  "atmospheric",
  "breakbeats",
] as const;

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

// ── The NEWSLETTER family (why-lines off editions.content_json) ───────────────────────
//
// An edition's per-finding "why" line is the newsletter's generated prose — the same
// body-clock reflex the other families reach for ("knees went up before I'd clocked the
// drop"). The content is a JSON payload (`galaxies[].findings[].why`), so the corpus is
// the flattened set of those lines. A malformed or partial payload (a draft mid-author)
// must never crash the harness, so the parse is defensive and yields [] on any shape it
// does not recognise — the same degrade-not-throw contract the public edition read uses.

/** One finding reference inside an edition — matches the `EditionFindingRef` read shape. */
type EditionFindingRef = { logId?: unknown; why?: unknown };
/** One galaxy block inside an edition — matches the `EditionGalaxyBlock` read shape. */
type EditionGalaxyBlock = { findings?: unknown };
/** The edition content payload as `content_json` stores it. */
type EditionContentShape = { galaxies?: unknown };

/**
 * Pull the per-finding "why" lines out of one edition's `content_json` as measurable
 * artifacts (id = the finding's Log ID, text = the why line). Defensive: a payload that
 * is not the expected `{ galaxies: [{ findings: [{ logId, why }] }] }` shape — a draft
 * mid-author, a truncated write, plain garbage — yields an empty array rather than
 * throwing, so a single bad row never sinks the whole re-run.
 */
export function extractEditionWhyLines(contentJson: string): Artifact[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const galaxies = (parsed as EditionContentShape).galaxies;

  if (!Array.isArray(galaxies)) {
    return [];
  }

  const lines: Artifact[] = [];

  for (const block of galaxies) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const findings = (block as EditionGalaxyBlock).findings;

    if (!Array.isArray(findings)) {
      continue;
    }

    for (const finding of findings) {
      if (!finding || typeof finding !== "object") {
        continue;
      }

      const ref = finding as EditionFindingRef;
      const why = typeof ref.why === "string" ? ref.why.trim() : "";

      if (why.length === 0) {
        continue;
      }

      lines.push({ id: typeof ref.logId === "string" ? ref.logId : "?", text: why });
    }
  }

  return lines;
}

// ── The CONTEXT-NOTE Texture vocabulary (the upstream seed) ───────────────────────────
//
// The `context_distil` prompt ends every note on a `Texture: a, b, c` line — 3–6 comma-
// separated pointers that seed EVERY downstream voice (note, observation, video). The
// 07-14 audit named this the upstream cause: the descriptor palette is narrow and recycled
// (`rolling` 34, `breakbeats` 27, `liquid` 25, `introspective` 25, `atmospheric` 19 over 61),
// and that monochrome fuel flows straight into the notes and observations. The same day the
// prompt was changed to demand track-specific pointers and name those five as worn through.
// This histogram is what makes that fix VERIFIABLE: re-run it and the worn five should thin.

/** One tracked worn-through Texture descriptor and how many notes still reach for it. */
export type WornDescriptor = CrutchWord;

/** The Texture-vocabulary reading over the context notes. */
export type TextureVocabStats = {
  /** Descriptor vocabulary ranked by how many notes use it (docFreq ≥ 2), top-K. */
  descriptors: WordCount[];
  /** Context notes that carry a parseable `Texture:` line (the measure's denominator). */
  size: number;
  /** Total context notes scanned (with non-empty text), parseable Texture line or not. */
  total: number;
  /** How many distinct descriptors appear at least once across the corpus. */
  vocabulary: number;
  /** The tracked worn-through descriptors, document frequency, in the order asked. */
  worn: WornDescriptor[];
};

/**
 * Pull the descriptors off a context note's final `Texture:` line. The prompt puts it last
 * ("add exactly one final line beginning 'Texture: '"), so the LAST such line wins if a note
 * somehow carries more than one. Returns the lowercased, comma-split descriptors with any
 * surrounding punctuation (the line's trailing full stop) trimmed off; an empty array when no
 * `Texture:` line is present. A multi-word descriptor ("halogen-lit", "rolling breakbeats") is
 * kept WHOLE — the descriptor histogram measures the phrase the prompt emits, so a recycled
 * compound like "rolling breakbeats" surfaces as its own cliché rather than dissolving into
 * two tokens. (The worn-WORD cut below tokenises, to stay comparable to the audit's counts.)
 */
export function extractTextureDescriptors(contextNote: string): string[] {
  const lines = contextNote.split(/\r?\n/);
  let textureLine: string | undefined;

  for (const line of lines) {
    const match = /^\s*texture\s*:\s*(.*)$/i.exec(line);

    if (match && typeof match[1] === "string" && match[1].trim().length > 0) {
      textureLine = match[1];
    }
  }

  if (textureLine === undefined) {
    return [];
  }

  return textureLine
    .split(",")
    .map((descriptor) =>
      descriptor
        .trim()
        .toLowerCase()
        // Trim surrounding punctuation (a trailing "." on the last descriptor, stray quotes)
        // while keeping internal hyphens/spaces — "atmospheric depth." → "atmospheric depth".
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/[^\p{L}\p{N}]+$/u, ""),
    )
    .filter((descriptor) => descriptor.length > 0);
}

/** Split a descriptor into its word tokens (for the audit-comparable worn-WORD count). */
function descriptorTokens(descriptor: string): string[] {
  return descriptor.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/**
 * The Texture-vocabulary histogram over the context notes, plus the document frequency of a
 * caller-supplied list of worn-through descriptors (the 07-14 audit's `rolling`/`liquid`/
 * `introspective`/`atmospheric`/`breakbeats`). Each note contributes each of its descriptors
 * once (a note repeating a descriptor still counts one), so the numbers read as "N of M
 * notes reach for this".
 *
 * TWO cuts, deliberately: the `descriptors` histogram keeps the authored comma-items whole
 * (so a recycled compound like "rolling breakbeats" is visible as one cliché), while `worn`
 * counts by WORD TOKEN — a note counts for "rolling" whether it wrote "rolling" or "rolling
 * breakbeats" — because that is how the audit counted, and a token count is what makes the
 * 07-14 prompt fix comparable to its before-numbers. Pure and deterministic.
 */
export function measureTextureVocab(
  notes: readonly Artifact[],
  options: { topK?: number; wornWords?: readonly string[] } = {},
): TextureVocabStats {
  const { topK = 20, wornWords = [] } = options;
  const populated = notes.filter((note) => note.text.trim().length > 0);

  const docFreq = new Map<string, number>();
  const tokenDocFreq = new Map<string, number>();
  let withTexture = 0;

  for (const note of populated) {
    const descriptors = new Set(extractTextureDescriptors(note.text));

    if (descriptors.size === 0) {
      continue;
    }

    withTexture += 1;

    for (const descriptor of descriptors) {
      docFreq.set(descriptor, (docFreq.get(descriptor) ?? 0) + 1);
    }

    // Word tokens, unioned across this note's descriptors, counted once per note.
    const tokens = new Set([...descriptors].flatMap((descriptor) => descriptorTokens(descriptor)));

    for (const token of tokens) {
      tokenDocFreq.set(token, (tokenDocFreq.get(token) ?? 0) + 1);
    }
  }

  const descriptors = [...docFreq.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([word, freq]) => ({ docFreq: freq, word }));

  const worn = wornWords.map((word) => {
    const needle = word.toLowerCase();

    return { docFreq: tokenDocFreq.get(needle) ?? 0, word: needle };
  });

  return {
    descriptors,
    size: withTexture,
    total: populated.length,
    vocabulary: docFreq.size,
    worn,
  };
}

// ── The VIDEO axes (categorical distributions + the palette NULL share) ───────────────
//
// The video family's homogenisation is not a phrase but a look: four consecutive renders
// sharing one amber halftone palette (07-13), the register axis collapsing to 92%
// representational (07-14). Those axes are stored as flat category tags on the finding
// (video_vehicle / video_grain / video_register / video_palette). This measures each as a
// simple share-of-population distribution — and reports the NULL share honestly, because
// `video_palette` (shipped in PR #702) is null on every render made before it existed.

/** One category value and how many artifacts carry it. */
export type CategoryCount = {
  /** How many artifacts carry this exact value. */
  count: number;
  /** The category value (a vehicle name, a grain family, a register, a palette bucket). */
  value: string;
};

/** The distribution of one categorical axis across a population, with its NULL share. */
export type CategoricalDistribution = {
  /** The category values ranked by count (desc), then value — the shape of the axis. */
  categories: CategoryCount[];
  /** How many rows carry NO value on this axis (`total - present`). */
  nullCount: number;
  /** How many rows carry a non-empty value on this axis. */
  present: number;
  /** Total rows considered (the population — e.g. every finding that has a video). */
  total: number;
};

/**
 * The distribution of a single categorical axis (vehicle / grain / register / palette) over
 * a population. A null or blank value is not a category — it is counted into `nullCount`, so
 * an axis that is mostly unrecorded (palette on pre-#702 renders) reads as a big NULL share
 * rather than a false "no repetition". Categories are ranked by count so the report leads
 * with the attractor.
 */
export function categoricalDistribution(
  values: readonly (string | null | undefined)[],
): CategoricalDistribution {
  const counts = new Map<string, number>();
  let present = 0;

  for (const raw of values) {
    const value = typeof raw === "string" ? raw.trim() : "";

    if (value.length === 0) {
      continue;
    }

    present += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const categories = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ count, value }));

  return { categories, nullCount: values.length - present, present, total: values.length };
}

// ── The EMBEDDING-DISTANCE cut (the one automated layer that sees MOVES, not words) ────
//
// Every other measure here is lexical — it counts shared WORDS. A paraphrase (the same move
// in different words) is invisible to it, which is the escape the note echo gate leaves open.
// A text embedding sees the MEANING, so two scripts that make the same body-clock move in
// different words land close in vector space even with zero shared content words. This is the
// only automated layer that could catch that — BUT baseline similarity across one persona,
// one register, one genre is high by design, so whether the distance actually SEPARATES the
// condemned pairs from the healthy ones is an empirical question, not an assumption. The math
// here is pure (cosine distance over supplied vectors); the model that produces the vectors
// lives in the runner, behind an opt-in flag, so this file needs no model dependency.

/** One artifact and its embedding vector. */
export type EmbeddedArtifact = {
  /** The artifact's id (a Log ID). */
  id: string;
  /** Its embedding vector (any dimensionality; the model decides). */
  vector: readonly number[];
};

/** The embedding distance between one pair of artifacts. */
export type PairDistance = {
  /** The first artifact's id. */
  a: string;
  /** The second artifact's id. */
  b: string;
  /** Their cosine distance (0 = identical direction, up to 2 = opposite). */
  distance: number;
};

/** The pairwise embedding-distance reading over a family. */
export type EmbeddingDistanceStats = {
  /** Every unordered pair's distance, ascending (closest — most similar — first). */
  pairs: PairDistance[];
  /** Mean cosine distance over every unordered pair. */
  mean: number;
  /** Standard deviation of the pairwise distances (how tight the corpus clusters). */
  stdev: number;
  /** The single smallest pairwise distance (the most-similar pair). */
  min: number;
  /** The most-similar pair's ids ([] when fewer than two vectors). */
  minPair: string[];
  /** Number of vectors measured (the denominator). */
  size: number;
};

/**
 * Cosine distance between two vectors: `1 - (a·b)/(‖a‖‖b‖)`. Robust to un-normalised inputs
 * (it divides by the norms), so it does not silently assume the caller normalised. A
 * zero-length vector has no direction, so its distance is reported as the maximum-unlike 1.
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;

    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 1;
  }

  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));

  // Clamp against floating-point drift beyond [-1, 1], then to a distance in [0, 2].
  return 1 - Math.max(-1, Math.min(1, cosine));
}

/**
 * The pairwise embedding-distance reading over a family: every unordered pair's cosine
 * distance, ascending, plus mean / stdev / min. O(n²) in the corpus — an offline operator
 * measure over a few hundred vectors, never a request path. Fewer than two vectors gives a
 * clean zeroed reading.
 */
export function pairwiseEmbeddingStats(
  embedded: readonly EmbeddedArtifact[],
): EmbeddingDistanceStats {
  const pairs: PairDistance[] = [];

  for (let i = 0; i < embedded.length; i += 1) {
    for (let j = i + 1; j < embedded.length; j += 1) {
      const left = embedded[i];
      const right = embedded[j];

      if (!left || !right) {
        continue;
      }

      pairs.push({ a: left.id, b: right.id, distance: cosineDistance(left.vector, right.vector) });
    }
  }

  pairs.sort((x, y) => x.distance - y.distance);

  if (pairs.length === 0) {
    return { mean: 0, min: 0, minPair: [], pairs, size: embedded.length, stdev: 0 };
  }

  const mean = pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length;
  const variance = pairs.reduce((sum, pair) => sum + (pair.distance - mean) ** 2, 0) / pairs.length;
  const closest = pairs[0];

  return {
    mean,
    min: closest ? closest.distance : 0,
    minPair: closest ? [closest.a, closest.b] : [],
    pairs,
    size: embedded.length,
    stdev: Math.sqrt(variance),
  };
}

/**
 * Where a specific pair sits in a family's pairwise-distance ordering — the validation the
 * embedding experiment turns on. A condemned pair that lands at rank 1 (the closest pair) far
 * below the median SEPARATES; one that sits mid-pack OVERLAPS with the healthy pairs and adds
 * no gate signal. `rank` is 1-based over pairs sorted closest-first; `percentile` is the
 * fraction of pairs that are FARTHER (more diverse) than this one — 1.0 means "the closest
 * pair in the whole corpus". Undefined when the pair is not present.
 */
export function rankPairDistance(
  stats: EmbeddingDistanceStats,
  idA: string,
  idB: string,
): { distance: number; percentile: number; rank: number; totalPairs: number } | undefined {
  const index = stats.pairs.findIndex(
    (pair) => (pair.a === idA && pair.b === idB) || (pair.a === idB && pair.b === idA),
  );

  if (index === -1) {
    return undefined;
  }

  const pair = stats.pairs[index];

  if (!pair) {
    return undefined;
  }

  const totalPairs = stats.pairs.length;

  return {
    distance: pair.distance,
    percentile: totalPairs <= 1 ? 1 : (totalPairs - 1 - index) / (totalPairs - 1),
    rank: index + 1,
    totalPairs,
  };
}
