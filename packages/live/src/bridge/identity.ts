export type Finding = {
  logId: string;
  title: string;
  artists: string[];

  bpm?: number | null;

  key?: string | null;
};

export type ObservedDeck = {
  title: string;
  artist: string;
  bpm?: number | null;

  key?: string | null;
};

export type DeckMatch = {
  index: number;
  score: number;
  reason: string;
};

const HOMOGLYPHS: Record<string, string> = {
  Α: "A",
  Β: "B",
  Ε: "E",
  Η: "H",
  Κ: "K",
  Μ: "M",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
};

function foldHomoglyphs(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKC")) {
    out += HOMOGLYPHS[ch] ?? ch;
  }
  return out;
}

const NEUTRAL_DESCRIPTOR = /\b(original mix|original|radio edit|extended mix|album version)\b/g;

function stripLeadingPunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "");
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeText(raw: string): string {
  let s = foldHomoglyphs(raw);
  s = stripLeadingPunctuation(s);
  s = stripAccents(s).toLowerCase();
  s = s.replace(/&/g, " and ");

  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/g, " ");
  s = s.replace(NEUTRAL_DESCRIPTOR, " ");

  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim().replace(/\s+/g, " ");
}

const VERSION_MARKERS = [
  "remix",
  "vip",
  "edit",
  "bootleg",
  "flip",
  "rework",
  "refix",
  "dub",
  "remaster",
  "instrumental",
  "acapella",
  "mashup",
  "mix",
];

function versionSignature(normalized: string): Set<string> {
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  const sig = new Set<string>();
  for (const marker of VERSION_MARKERS) {
    if (tokens.has(marker)) {
      sig.add(marker);
    }
  }
  return sig;
}

function sameVersion(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const m of a) {
    if (!b.has(m)) {
      return false;
    }
  }
  return true;
}

const CAMELOT_MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "Db"];
const CAMELOT_MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];

const PITCH_CLASS: Record<string, number> = {
  a: 9,
  "a#": 10,
  ab: 8,
  b: 11,
  "b#": 0,
  bb: 10,
  c: 0,
  "c#": 1,
  cb: 11,
  d: 2,
  "d#": 3,
  db: 1,
  e: 4,
  "e#": 5,
  eb: 3,
  f: 5,
  "f#": 6,
  fb: 4,
  g: 7,
  "g#": 8,
  gb: 6,
};

export function keyTonicPitchClass(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const s = foldHomoglyphs(raw).trim();

  const cam = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (cam) {
    const n = Number(cam[1]);
    if (n >= 1 && n <= 12) {
      const wheel = cam[2].toUpperCase() === "A" ? CAMELOT_MINOR : CAMELOT_MAJOR;
      return PITCH_CLASS[wheel[n - 1].toLowerCase()] ?? null;
    }
    return null;
  }

  const note = /^([a-gA-G])\s*([#b♯♭]?)/.exec(s);
  if (note) {
    let acc = note[2];
    if (acc === "♯") {
      acc = "#";
    } else if (acc === "♭") {
      acc = "b";
    }
    const tonic = (note[1] + acc).toLowerCase();
    return PITCH_CLASS[tonic] ?? null;
  }
  return null;
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = Array.from<number>({ length: b.length + 1 });
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) {
    return 1;
  }
  return 1 - editDistance(a, b) / maxLen;
}

function textScore(a: string, b: string): number {
  const base = similarity(a, b);
  const at = new Set(a.split(" ").filter(Boolean));
  const bt = new Set(b.split(" ").filter(Boolean));
  if (at.size === 0 || bt.size === 0) {
    return base;
  }
  let shared = 0;
  for (const t of at) {
    if (bt.has(t)) {
      shared++;
    }
  }
  const containment = shared / Math.min(at.size, bt.size);
  const overlap = shared / Math.max(at.size, bt.size);

  const tokenScore = containment * (0.5 + 0.5 * overlap);
  return Math.max(base, (base + tokenScore) / 2);
}

const MATCH_THRESHOLD = 0.62;

const BPM_TOLERANCE = 3;

function bpmAgrees(observed: number, stored: number): boolean {
  const candidates = [stored, stored / 2, stored * 2, observed / 2, observed * 2];
  return (
    candidates.some((c) => Math.abs(observed - c) <= BPM_TOLERANCE) ||
    Math.abs(observed - stored) <= BPM_TOLERANCE
  );
}

export function resolveDeck(observed: ObservedDeck, findings: Finding[]): DeckMatch | null {
  const obsTitle = normalizeText(observed.title ?? "");
  const obsArtist = normalizeText(observed.artist ?? "");
  if (obsTitle.length === 0) {
    return null;
  }
  const obsBpm =
    typeof observed.bpm === "number" && Number.isFinite(observed.bpm) ? observed.bpm : null;
  const obsTonic = keyTonicPitchClass(observed.key);
  const obsVersion = versionSignature(obsTitle);

  let best: DeckMatch | null = null;

  for (let index = 0; index < findings.length; index++) {
    const f = findings[index];
    const fTitle = normalizeText(f.title ?? "");
    const fArtist = normalizeText((f.artists ?? []).join(" and "));

    if (!sameVersion(obsVersion, versionSignature(fTitle))) {
      continue;
    }

    const titleScore = textScore(obsTitle, fTitle);

    const artistScore = obsArtist.length === 0 ? titleScore : textScore(obsArtist, fArtist);

    let score = 0.7 * titleScore + 0.3 * artistScore;

    const reasons: string[] = [
      `title ${titleScore.toFixed(2)}`,
      `artist ${artistScore.toFixed(2)}`,
    ];

    if (obsBpm !== null && typeof f.bpm === "number" && Number.isFinite(f.bpm)) {
      if (bpmAgrees(obsBpm, f.bpm)) {
        score += 0.03;
        reasons.push("bpm✓");
      } else {
        reasons.push("bpm✗(ignored)");
      }
    }

    if (obsTonic !== null) {
      const fTonic = keyTonicPitchClass(f.key ?? null);
      if (fTonic !== null) {
        if (fTonic === obsTonic) {
          score += 0.03;
          reasons.push("key✓");
        } else {
          reasons.push("key✗(ignored)");
        }
      }
    }

    score = Math.min(1, score);
    if (best === null || score > best.score) {
      best = { index, reason: reasons.join(" "), score };
    }
  }

  if (best === null || best.score < MATCH_THRESHOLD) {
    return null;
  }
  return best;
}
