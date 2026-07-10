// DECK IDENTITY — the pure resolver half of the live show's "what is playing" problem.
//
// Two orthogonal questions run the show:
//   IDENTITY — *what* track is on a deck (this file).
//   CHANGE   — *which* deck went live and *when* (the MIDI mixer-state feed, a separate PR).
//
// The identity signal comes from OCR'ing Rekordbox's deck headers (deckwatch.py) — the
// only place a DJ's *intended* track name lives, before a note is even heard. This module
// takes ONE observed header `{ title, artist, bpm?, key? }` and resolves it to a finding in
// the archive, or returns null. Null is the load-bearing rail: it fires both when OCR is
// noise AND when the DJ plays a track that simply isn't a finding — the caller then falls
// back to a random-VJ scene rather than ever showing the WRONG finding on the wall.
//
// This file is PURE: zero I/O, no capture, no network. It is the tested seam between the
// macOS-specific OCR script and the bridge. Everything the resolver needs arrives as args.

/** The minimal shape of an archive finding the resolver matches against (a subset of the
 * public track DTO). `bpm` and `key` are nullable in the archive (5/48 have no key, 4/48 no
 * bpm) and are COARSE GUARDS ONLY — never the identity. */
export type Finding = {
  logId: string;
  title: string;
  artists: string[];
  /** Fluncle's stored DSP bpm. Reads ~1.5 low vs Rekordbox; nullable. */
  bpm?: number | null;
  /** Fluncle's stored key as sharp-spelled scale text, e.g. "G major" / "A# minor". Nullable. */
  key?: string | null;
};

/** What deckwatch.py OCR's off one deck header. bpm/key are best-effort reads. */
export type ObservedDeck = {
  title: string;
  artist: string;
  bpm?: number | null;
  /** Rekordbox may display Camelot ("6A") OR Classic ("Gm") depending on a user pref. */
  key?: string | null;
};

/** A resolved match: which archive `index`, a 0..1 `score`, and a human-readable `reason`. */
export type DeckMatch = {
  index: number;
  score: number;
  reason: string;
};

// ── Text normalization ───────────────────────────────────────────────────────

// Cyrillic/Greek homoglyphs Vision hands back for isolated Latin capitals (see deckwatch).
// Folded here too so a resolver fed a raw OCR string is never silently defeated by a
// non-Latin lookalike.
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

// Descriptors that mean "this IS the original recording" — pure noise for matching, dropped
// so Rekordbox's "Strength (Original Mix)" matches the archive's bare "Strength". Anything
// NOT on this list (Remix, VIP, Edit, Bootleg, Flip, Rework, Dub, …) is IDENTITY and is
// PRESERVED — a remix must never collapse onto the original.
const NEUTRAL_DESCRIPTOR = /\b(original mix|original|radio edit|extended mix|album version)\b/g;

/** Strip a leading deck-number badge / stray punctuation bleed ("- I See The Future" -> "I
 * See The Future"). Only leading non-alphanumerics are removed; interior punctuation stays. */
function stripLeadingPunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Fold accents to ASCII (é -> e) so "Déjà" matches "Deja". */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Normalize a title/artist string for fuzzy comparison. Order matters: homoglyph fold and
 * leading-punctuation strip run on the raw OCR first, THEN lowercase/accent/`&`/feat cleanup.
 * Neutral descriptors ("Original Mix") are dropped but real ones (Remix/VIP/Edit) survive as
 * identity — the caller relies on that to keep a remix off the original.
 */
export function normalizeText(raw: string): string {
  let s = foldHomoglyphs(raw);
  s = stripLeadingPunctuation(s);
  s = stripAccents(s).toLowerCase();
  s = s.replace(/&/g, " and ");
  // Drop a trailing "feat./ft./featuring …" credit — it is not part of the title identity.
  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/g, " ");
  s = s.replace(NEUTRAL_DESCRIPTOR, " ");
  // Collapse any remaining bracketing and punctuation to spaces, then squeeze whitespace.
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ");
  return s.trim().replace(/\s+/g, " ");
}

// Version markers that make a track a DIFFERENT identity from the original. If an observed
// header carries one the finding does not (or vice versa), they are not the same recording —
// a remix must never collapse onto the original. This is a HARD disqualifier, not a fuzzy
// nudge, because token containment alone scores "Deadweight (X Remix)" against "Deadweight"
// high enough to cross the threshold. "Original Mix" etc. are stripped as NEUTRAL above and so
// never appear here.
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

/** The set of version markers present in a normalized string (its "which recording" signature). */
export function versionSignature(normalized: string): Set<string> {
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  const sig = new Set<string>();
  for (const marker of VERSION_MARKERS) {
    if (tokens.has(marker)) {
      sig.add(marker);
    }
  }
  return sig;
}

/** Two version signatures name the same recording only when they are the SAME set. */
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

// ── Camelot ↔ tonic ──────────────────────────────────────────────────────────
//
// VERIFIED against the two ground-truth decks measured live:
//   5A -> C  (Netsky "I See The Future…", Rekordbox 5A)   — matches archive tonic C
//   6A -> G  (Technimatic "Strength", Rekordbox 6A)       — matches archive tonic G
// Fluncle stores mode too ("G major") but the mode DEMONSTRABLY disagrees (6A is G minor,
// the archive says "G major"), so the key guard compares the TONIC ONLY.

// Minor wheel 1A..12A and major wheel 1B..12B, tonic pitch-class per Camelot.
const CAMELOT_MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "Db"];
const CAMELOT_MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];

// Pitch class 0..11 for a tonic spelling (both sharps and flats). Enharmonics share a class,
// which is exactly what a tonic-only compare wants (F# == Gb).
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

/**
 * Reduce any key spelling — Camelot ("6A"), Classic ("Gm" / "F#"), or Fluncle scale text
 * ("G major" / "A# minor") — to a 0..11 tonic pitch class, ignoring mode. Null when it can't
 * be parsed (the guard then simply doesn't fire). Homoglyph-folded first (Vision returned a
 * Cyrillic "А" in "5А").
 */
export function keyTonicPitchClass(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const s = foldHomoglyphs(raw).trim();

  // Camelot: 1..12 followed by A (minor) or B (major).
  const cam = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (cam) {
    const n = Number(cam[1]);
    if (n >= 1 && n <= 12) {
      const wheel = cam[2].toUpperCase() === "A" ? CAMELOT_MINOR : CAMELOT_MAJOR;
      return PITCH_CLASS[wheel[n - 1].toLowerCase()] ?? null;
    }
    return null;
  }

  // Classic / scale text: a note letter, optional accidental, then anything (mode) we ignore.
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

// ── Fuzzy string similarity ────────────────────────────────────────────────────

/** Levenshtein edit distance (small strings; iterative two-row). */
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

/** Normalized 0..1 similarity between two already-normalized strings (1 = identical). */
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

/**
 * Token-aware similarity: the plain edit-distance ratio, lifted when one string's token set
 * is a subset of the other's (a truncated OCR title — "I See The Future" for "I See The
 * Future In Your Eyes" — should still score high). Returns the stronger of the two.
 */
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
  // Subset containment is strong evidence, but weight by overlap so a single shared stopword
  // can't carry it. Average with the char ratio.
  const tokenScore = containment * (0.5 + 0.5 * overlap);
  return Math.max(base, (base + tokenScore) / 2);
}

// ── The resolver ───────────────────────────────────────────────────────────────

/** Accept a title+artist match at or above this fused score; below it, return null. */
const MATCH_THRESHOLD = 0.62;
/** bpm guard tolerance (Rekordbox vs Fluncle DSP differ ~1.5; give generous slack). */
const BPM_TOLERANCE = 3;

/** True when `observed` bpm is within tolerance of `stored`, at 1x / half / double time. */
function bpmAgrees(observed: number, stored: number): boolean {
  const candidates = [stored, stored / 2, stored * 2, observed / 2, observed * 2];
  return (
    candidates.some((c) => Math.abs(observed - c) <= BPM_TOLERANCE) ||
    Math.abs(observed - stored) <= BPM_TOLERANCE
  );
}

/**
 * Resolve an OCR'd deck header to an archive finding, or null.
 *
 * PRIMARY signal: fuzzy title + artist (title weighted heavier). Against a ~60-item archive
 * this is near-unambiguous on its own. bpm and key are GUARDS only — a small nudge when they
 * agree, but they never REJECT a strong title+artist match and never ACCEPT on their own.
 *
 * Returns the best match `{ index, score, reason }` when the fused score clears the
 * threshold, else null — the never-show-the-wrong-finding rail.
 */
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

    // HARD gate: a differing version signature (remix/VIP/edit/…) is a different recording.
    // Skip it entirely so a remix can never resolve to the original (or vice versa).
    if (!sameVersion(obsVersion, versionSignature(fTitle))) {
      continue;
    }

    const titleScore = textScore(obsTitle, fTitle);
    // Artist can be blank in OCR (badge bleed) — don't let a missing artist tank a title hit.
    const artistScore = obsArtist.length === 0 ? titleScore : textScore(obsArtist, fArtist);
    // Title carries identity; artist confirms. 0.7 / 0.3.
    let score = 0.7 * titleScore + 0.3 * artistScore;

    const reasons: string[] = [
      `title ${titleScore.toFixed(2)}`,
      `artist ${artistScore.toFixed(2)}`,
    ];

    // GUARD: bpm. Nudge up on agreement; never reject on disagreement.
    if (obsBpm !== null && typeof f.bpm === "number" && Number.isFinite(f.bpm)) {
      if (bpmAgrees(obsBpm, f.bpm)) {
        score += 0.03;
        reasons.push("bpm✓");
      } else {
        reasons.push("bpm✗(ignored)");
      }
    }

    // GUARD: key tonic (mode ignored). Nudge up on agreement; never reject on disagreement.
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
