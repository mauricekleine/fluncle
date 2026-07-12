// The auto-note pipeline (Worker-side): the WRITTEN-note sibling of the spoken
// observation. A finding's `note` is its public editorial "why" — the line that
// shows on `/log/<id>`. Today the operator writes it by hand; this is the path that
// lets Fluncle AUTO-author it, mirroring the observation pipeline as closely as the
// difference between heard and read allows.
//
// Two registers, two gates:
//   - the observation SCRIPT is SPOKEN (recovered-audio): scanned by
//     `gateObservationScript` (observation.ts), rendered to mp3, internal until a
//     surface plays it.
//   - the NOTE is WRITTEN and PUBLIC: it lands straight on `/log`, so its gate is
//     the same DEFENCE-IN-DEPTH shape — the agent authors through
//     `copywriting-fluncle`, and the Worker re-runs the mechanical scan and
//     hard-fails any violation before the note is stored.
//
// The bans are SHARED with the spoken gate (one VOICE.md §3 banned-identity-word
// list, one earthly-geography list, the Dry Rule's no-exclamation-marks, no
// "we"-as-company) — `scanObservationScript` is the single source of truth, so a
// word banned in the heard surface is banned in the read one too. Only the LENGTH
// bound differs: a note is a short editorial line (the public `NOTE_MAX_LENGTH`
// 280-char budget), not a 20–45s read.
//
// THE SECOND GATE — the ECHO gate (the anti-sameness rail). The auto-note is now
// authored with its finding's SONIC NEIGHBOURS' notes in the prompt (the
// vibe-neighbour layer). That is the feature's whole risk: neighbour notes are there
// to show the model what this REGION of the archive already sounds like so it writes
// something ELSE — the cluster INFORMS but never TEMPLATES, and a note that reads
// like every other note in its galaxy is worse than none. So the rail is MECHANICAL,
// not hoped for: `gateNoteEcho` re-reads the same neighbour notes the agent saw and
// hard-fails a note that lifts a phrase from one or overlaps it too far.
//
// A REJECTED NOTE IS HELD, NEVER BINNED. The gate refuses to STORE the line on the
// finding — that part is unchanged, and the finding stays note-less until a better line
// lands. But the line itself is written to the `note_rejections` ledger with the reason
// (which neighbour, which phrase, what score, and the thresholds that were in force),
// and it raises a row in the operator's `/admin` attention queue. He reads what the model
// wrote and rules: keep it, edit it, or bin it.
//
// The distinction is the whole point. "Silence beats a generic line" is a rule about what
// PUBLISHES; it was never a licence to destroy the model's work without telling anyone.
// A gate whose rejections nobody can see is a gate nobody can supervise: you cannot tell
// a good bin from a bad one, and you cannot tell a well-set threshold from a wrong one,
// because the evidence is gone. The dials are tunable (the `settings` KV) precisely so
// that evidence can change them — which requires keeping it.

import { NOTE_MAX_LENGTH } from "../log-prose";
import { scanObservationScript } from "./observation";
import { ApiError } from "./spotify";

// A note is a single editorial line, not a paragraph. Floor it well below the
// spoken script's 80 so a terse, certain note ("Pure rolling menace. That's why
// it's here.") clears, but a one-word stub doesn't. The ceiling is the SAME public
// budget the operator's hand-written note is held to (`parseEditorialNote` →
// NOTE_MAX_LENGTH), so an auto-note can never store a longer string than a typed one.
const NOTE_MIN_CHARS = 24;
const NOTE_MAX_CHARS = NOTE_MAX_LENGTH;

/**
 * Validate + voice-gate an agent-authored finding note, throwing a clean ApiError on
 * any failure (the handler's catch turns it into a 4xx). Returns the trimmed note on
 * success. Reuses the spoken gate's shared banned-word / earthly-geography /
 * exclamation / "we"-as-company scan (one source of truth), with the WRITTEN note's
 * own length bounds. The note is a public `/log` surface, so a violation hard-fails
 * the store before the note is ever shown.
 */
export function gateNoteText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError("no_note", "A `note` (the finding's editorial line) is required", 400);
  }

  const trimmed = text.trim();

  if (trimmed.length < NOTE_MIN_CHARS) {
    throw new ApiError(
      "note_too_short",
      `The note is too short (${trimmed.length} < ${NOTE_MIN_CHARS} chars)`,
      422,
    );
  }

  if (trimmed.length > NOTE_MAX_CHARS) {
    throw new ApiError(
      "note_too_long",
      `The note is too long (${trimmed.length} > ${NOTE_MAX_CHARS} chars)`,
      422,
    );
  }

  const violations = scanObservationScript(trimmed);

  if (violations.length > 0) {
    throw new ApiError(
      "voice_gate",
      `The note fails the voice gate: ${violations.map((violation) => violation.reason).join("; ")}`,
      422,
    );
  }

  return trimmed;
}

// ── The echo gate — the anti-sameness rail on the vibe-neighbour layer ────────────
//
// Two signals, measured against the notes of the finding's SONIC NEIGHBOURS (the
// exact notes the authoring prompt showed the model). Both thresholds were calibrated
// against the live 61-note archive (see the PR): the corpus's own worst offender lifts
// a 6-token run from a neighbour, its mean max-neighbour overlap is 0.10, and nothing
// in it reaches 0.30 overlap. So the gate bites on the genuine echoes and lets an
// honestly-different line through.
//
//   1. A LIFTED PHRASE — the longest run of consecutive words the candidate shares
//      with a neighbour. Four words carrying at least one content word ("my shoulders
//      dropped before", "I've been rewinding it since") is a borrowed move, not a
//      coincidence. This is the signal that actually catches the failure mode: the
//      voice has a small stock of bodily images, and paraphrase-by-neighbour reuses
//      the phrasing verbatim.
//   2. WHOLESALE OVERLAP — the Jaccard overlap of content words. It catches the
//      rewrite that dodges the n-gram by reordering ("the liquid dropped my shoulders"
//      vs "my shoulders still follow") but says the same thing with the same words.
//
// Both are cheap, pure, and deterministic — no model in the loop judging its own work.

/**
 * The gate's two dials. They are OPERATOR-TUNABLE at runtime (the `settings` KV —
 * `getNoteEchoThresholds` in note-rejections.ts), because the calibration below is a
 * measurement of one 61-note archive at one moment, not a law: as the corpus grows, the
 * honest threshold moves, and finding that out must not require a deploy. These are the
 * defaults the gate falls back to when the KV is unset.
 *
 * Every rejection SNAPSHOTS the values that were in force when it was made, so retuning
 * these can never rewrite the meaning of a past rejection.
 */
export const NOTE_ECHO_DEFAULTS = {
  /** Content-word overlap at or above this reads as the same note wearing a new hat. */
  maxOverlap: 0.3,
  /** A run of consecutive shared words this long (with a content word in it) is a lift. */
  minPhraseWords: 4,
} as const;

/** The gate's dials, as read for one gating run (the KV values, or the defaults). */
export type NoteEchoThresholds = {
  maxOverlap: number;
  minPhraseWords: number;
};

// Function words carry no editorial content, so they are stripped before the overlap
// is measured (they would otherwise float every pair's Jaccard on "the", "it", "and").
// They are KEPT for the phrase run — "my shoulders dropped before" is a lifted move
// precisely because of its shape, function words and all.
const ECHO_STOPWORDS = new Set(
  (
    "a an the and or but of to in on at it its is was be been this that these those " +
    "i my me you your he she they them we our us with without for from as into onto " +
    "over under before after then than so very just still yet even more most much " +
    "many had have has do does did doing done got get gets not no nor if when while " +
    "where how what who which one ones another other any every each both there here " +
    "now s t re ve ll d m"
  ).split(" "),
);

/**
 * Normalize a note to a word stream: lowercase, punctuation dropped, apostrophes split.
 * Exported so the corpus-wide diversity harness (artifact-diversity.ts) measures phrases
 * over exactly the same word stream the echo gate does — one definition of "the words".
 */
export function echoWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The content words of a note — the words that carry the editorial claim. Exported for
 * the diversity harness's single-word recurrence scan (the "is 'shoulders' still in N of M
 * observations" measure), which reads content words by exactly this definition.
 */
export function echoContentWords(text: string): string[] {
  return echoWords(text).filter((word) => !ECHO_STOPWORDS.has(word) && word.length > 2);
}

/**
 * Content-word Jaccard overlap of two notes (0 = disjoint, 1 = the same words). Exported
 * so the diversity harness's mean-pairwise-overlap reads sameness by the SAME definition
 * the echo gate uses, and the two numbers are comparable.
 */
export function contentOverlap(a: string, b: string): number {
  const left = new Set(echoContentWords(a));
  const right = new Set(echoContentWords(b));

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }

  return shared / new Set([...left, ...right]).size;
}

/**
 * The longest run of consecutive words two notes share, or "" when the longest run is
 * shorter than the lift threshold or is pure function words (a shared "and I have been"
 * is grammar, not a borrowed image).
 */
function liftedPhrase(a: string, b: string, minPhraseWords: number): string {
  const left = echoWords(a);
  const right = echoWords(b);
  let best: string[] = [];

  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      let run = 0;

      while (i + run < left.length && j + run < right.length && left[i + run] === right[j + run]) {
        run += 1;
      }

      if (run > best.length) {
        best = left.slice(i, i + run);
      }
    }
  }

  if (best.length < minPhraseWords) {
    return "";
  }

  const carriesContent = best.some((word) => !ECHO_STOPWORDS.has(word) && word.length > 2);

  return carriesContent ? best.join(" ") : "";
}

/** One neighbour note the candidate is measured against (the notes the agent was shown). */
export type NoteNeighbor = { logId: string; note: string };

/** The worst echo a candidate note makes against its neighbourhood. */
export type NoteEcho = {
  /** True when the candidate crosses either threshold — it must not be stored. */
  echoes: boolean;
  /** The neighbour it echoes hardest (its Log ID), or null when there is nothing to echo. */
  logId: string | null;
  /**
   * That neighbour's note, as it read at scoring time ("" when there is nothing to echo).
   * Carried so the rejection ledger can snapshot the exact PAIR the gate compared — the
   * operator has to be able to see WHAT it echoed, not just be told that it did.
   */
  note: string;
  /** The content-word overlap with that neighbour (0..1). */
  overlap: number;
  /** The run of words lifted from that neighbour, or "" when none reaches the threshold. */
  phrase: string;
};

/**
 * Score a candidate note against the notes of its sonic neighbours — the mechanical
 * anti-sameness measurement behind the echo gate. Pure and deterministic; the same
 * function the sweep's report and the Worker's gate both read, so "how same is it"
 * has exactly one definition.
 *
 * Reports the WORST neighbour: the one with a lifted phrase (longest wins) or, absent
 * any lift, the highest content overlap. An empty neighbourhood (a finding with no
 * embedding yet, or the first note in a region) scores `{ echoes: false, overlap: 0 }`
 * — nothing to echo, so nothing to gate.
 */
export function scoreNoteEcho(
  note: string,
  neighbors: readonly NoteNeighbor[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): NoteEcho {
  let worst: NoteEcho = { echoes: false, logId: null, note: "", overlap: 0, phrase: "" };
  // Severity orders the neighbours: ANY lift outranks EVERY bare overlap (a lifted
  // phrase is the harder evidence), longer lifts outrank shorter ones, and among
  // lift-free neighbours the highest overlap wins. Overlap is < 1, so the +1 offset
  // keeps the two bands from ever crossing.
  const severity = (echo: NoteEcho) =>
    echo.phrase ? 1 + echo.phrase.split(" ").length : echo.overlap;
  let worstSeverity = -1;

  for (const neighbor of neighbors) {
    if (!neighbor.note.trim()) {
      continue;
    }

    const phrase = liftedPhrase(note, neighbor.note, thresholds.minPhraseWords);
    const overlap = contentOverlap(note, neighbor.note);
    const candidate: NoteEcho = {
      echoes: phrase.length > 0 || overlap >= thresholds.maxOverlap,
      logId: neighbor.logId,
      note: neighbor.note,
      overlap,
      phrase,
    };

    if (severity(candidate) > worstSeverity) {
      worstSeverity = severity(candidate);
      worst = candidate;
    }
  }

  return worst;
}

/**
 * Voice-gate's sibling: hard-fail an agent-authored note that ECHOES its sonic
 * neighbourhood, throwing a clean ApiError the handler turns into a 422. The message
 * names the neighbour and the lifted phrase, so the sweep can re-author against it.
 *
 * The rail this enforces (docs/agents/note-agent.md): the neighbour notes INFORM the
 * authoring — they show the region's register and the moves already spent — but they
 * must never be templated. A finding whose only available note echoes its neighbours
 * stays note-less; the note is optional, and silence beats a generic line.
 */
export function noteEchoError(echo: NoteEcho): ApiError {
  const detail = echo.phrase
    ? `it lifts "${echo.phrase}" straight from ${echo.logId}`
    : `it reuses ${Math.round(echo.overlap * 100)}% of ${echo.logId}'s words`;

  return new ApiError(
    "note_echoes_neighbours",
    `The note echoes its sonic neighbourhood: ${detail}. The neighbours inform the note, they never template it — write a line that is this finding's own. It is held for the operator's eye, not thrown away.`,
    422,
  );
}

export function gateNoteEcho(
  note: string,
  neighbors: readonly NoteNeighbor[],
  thresholds: NoteEchoThresholds = NOTE_ECHO_DEFAULTS,
): NoteEcho {
  const echo = scoreNoteEcho(note, neighbors, thresholds);

  if (!echo.echoes) {
    return echo;
  }

  throw noteEchoError(echo);
}
