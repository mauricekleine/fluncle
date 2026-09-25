import {
  contentOverlap,
  echoContentWords,
  echoWords,
  type NoteEcho,
  type NoteEchoThresholds,
  NOTE_ECHO_DEFAULTS,
  scoreNoteEcho,
} from "./note";

export const WORN_TEXTURE_WORDS = [
  "rolling",
  "liquid",
  "introspective",
  "atmospheric",
  "breakbeats",
] as const;

export type Artifact = {
  id: string;

  text: string;
};

export type PhraseCount = {
  docFreq: number;

  count: number;

  n: number;

  phrase: string;
};

export type WordCount = {
  docFreq: number;

  word: string;
};

export type NeighbourLift = {
  id: string;

  echo: NoteEcho;
};

export type FamilyDiversity = {
  family: string;

  size: number;

  meanPairwiseOverlap: number;

  maxPairwiseOverlap: number;

  maxPair: string[];

  topPhrases: PhraseCount[];

  topWords: WordCount[];

  neighbourLifts: NeighbourLift[];

  echoingCount: number;
};

export type PhraseOptions = {
  minN: number;

  maxN: number;

  topK: number;

  minDocFreq: number;
};

export const PHRASE_DEFAULTS: PhraseOptions = {
  maxN: 6,
  minDocFreq: 2,
  minN: 3,
  topK: 10,
};

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

function countNgrams(
  wordStreams: readonly string[][],
  n: number,
): Map<string, { count: number; docFreq: number }> {
  const totals = new Map<string, { count: number; docFreq: number }>();

  for (const words of wordStreams) {
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

  lifts.sort((a, b) => {
    const severity = (lift: NeighbourLift) =>
      lift.echo.phrase ? 1 + lift.echo.phrase.split(" ").length : lift.echo.overlap;

    return severity(b) - severity(a);
  });

  return lifts;
}

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

export type EdgePhrase = {
  docFreq: number;

  phrase: string;
};

export type CrutchWord = {
  docFreq: number;
  word: string;
};

export type RegisterStats = {
  closers: EdgePhrase[];

  crutches: CrutchWord[];

  openingWords: CrutchWord[];

  openers: EdgePhrase[];

  size: number;
};

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

export function measureRegisters(
  artifacts: readonly Artifact[],
  options: { crutchWords?: readonly string[]; edgeWords?: number; topK?: number } = {},
): RegisterStats {
  const { crutchWords = [], edgeWords = 3, topK = 8 } = options;
  const populated = artifacts.filter((artifact) => artifact.text.trim().length > 0);
  const streams = populated.map((artifact) => echoWords(artifact.text)).filter((w) => w.length > 0);

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

export function stripLogbookProse(body: string): string {
  return body
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/[*_#>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type EditionFindingRef = { logId?: unknown; why?: unknown };

type EditionGalaxyBlock = { findings?: unknown };

type EditionContentShape = { galaxies?: unknown };

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

export type WornDescriptor = CrutchWord;

export type TextureVocabStats = {
  descriptors: WordCount[];

  size: number;

  total: number;

  vocabulary: number;

  worn: WornDescriptor[];
};

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

        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/[^\p{L}\p{N}]+$/u, ""),
    )
    .filter((descriptor) => descriptor.length > 0);
}

function descriptorTokens(descriptor: string): string[] {
  return descriptor.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

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

export type CategoryCount = {
  count: number;

  value: string;
};

export type CategoricalDistribution = {
  categories: CategoryCount[];

  nullCount: number;

  present: number;

  total: number;
};

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

export type EmbeddedArtifact = {
  id: string;

  vector: readonly number[];
};

export type PairDistance = {
  a: string;

  b: string;

  distance: number;
};

export type EmbeddingDistanceStats = {
  pairs: PairDistance[];

  mean: number;

  stdev: number;

  min: number;

  minPair: string[];

  size: number;
};

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

  return 1 - Math.max(-1, Math.min(1, cosine));
}

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
