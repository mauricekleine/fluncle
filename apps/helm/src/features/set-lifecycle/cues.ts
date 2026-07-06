// The Rekordbox cue bridge, pure half — parse `rekordbox-derive-cues.py --json`'s
// output and shape it for `replace_recording_cues`. Pinned by cues.test.ts. The
// script matches each session row to a Fluncle finding (matched / ambiguous /
// unmatched) and prints the ordered cue array; the daemon reads a completed run's
// buffered stdout and hands the parsed cues to the panel, which attaches them to a
// selected take. `startMs` is deliberately absent — the operator marks each mix-in
// on the Studio cue rail later.

/** A cue as the derivation script reports it (with its match provenance). */
export type DerivedCue = {
  artistsText: string;
  findingId?: string;
  flagDetail: string | null;
  flaggedReason: string | null;
  fuzzy: boolean;
  matchBucket: "ambiguous" | "matched" | "unmatched";
  position: number;
  titleText: string;
};

export type DerivedCueCounts = {
  ambiguous: number;
  fuzzy: number;
  matched: number;
  repeats: number;
  unmatched: number;
};

/** The parsed `--json` payload (the fields the panel + the attach path use). */
export type DerivedCues = {
  counts: DerivedCueCounts;
  cues: DerivedCue[];
  inputRows: number;
  mode: string;
  prunedConsecutive: number;
  session: string;
};

/** A cue in the `replace_recording_cues` PUT body — the honest write target. */
export type ReplaceCue = {
  artistsText: string;
  findingId?: string;
  position: number;
  startMs?: number;
  titleText: string;
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBucket(value: unknown): DerivedCue["matchBucket"] {
  return value === "matched" || value === "ambiguous" ? value : "unmatched";
}

/**
 * Slice the outermost JSON object out of a run's stdout. In `--json` mode the
 * script prints only the object, but the buffer join is forgiving of a stray
 * leading/trailing line so a real run never fails to parse on whitespace.
 */
function sliceJsonObject(stdout: string): string {
  const trimmed = stdout.trim();
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");

  if (open === -1 || close === -1 || close < open) {
    throw new Error("no JSON object in the derivation output");
  }

  return trimmed.slice(open, close + 1);
}

/**
 * Parse `rekordbox-derive-cues.py --json` stdout into the cue set. Throws when the
 * output holds no parseable object or no `cues` array (a failed/empty run — the
 * caller surfaces that as an unparseable-run error, never a silent empty attach).
 */
export function parseDeriveCuesOutput(stdout: string): DerivedCues {
  const parsed: unknown = JSON.parse(sliceJsonObject(stdout));

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("derivation output is not an object");
  }

  const record = parsed as Record<string, unknown>;

  if (!Array.isArray(record.cues)) {
    throw new Error("derivation output has no cues array");
  }

  const cues: DerivedCue[] = record.cues.map((raw) => {
    const cue = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const findingId = asString(cue.findingId);

    return {
      artistsText: asString(cue.artistsText),
      ...(findingId.length > 0 ? { findingId } : {}),
      flagDetail: typeof cue.flagDetail === "string" ? cue.flagDetail : null,
      flaggedReason: typeof cue.flaggedReason === "string" ? cue.flaggedReason : null,
      fuzzy: cue.fuzzy === true,
      matchBucket: asBucket(cue.matchBucket),
      position: asNumber(cue.position),
      titleText: asString(cue.titleText),
    };
  });

  const counts = (
    typeof record.counts === "object" && record.counts !== null ? record.counts : {}
  ) as Record<string, unknown>;

  return {
    counts: {
      ambiguous: asNumber(counts.ambiguous),
      fuzzy: asNumber(counts.fuzzy),
      matched: asNumber(counts.matched),
      repeats: asNumber(counts.repeats),
      unmatched: asNumber(counts.unmatched),
    },
    cues,
    inputRows: asNumber(record.inputRows),
    mode: asString(record.mode, "dry-run"),
    prunedConsecutive: asNumber(record.prunedConsecutive),
    session: asString(record.session),
  };
}

/**
 * Shape the derived cues for the `replace_recording_cues` PUT body — the ordered
 * `{ findingId?, artistsText, titleText, position }` array, provenance stripped,
 * `startMs` left absent. Positions are reindexed 1..n so a hand-pruned preview
 * still writes a gapless order (the server reindexes too, but honest input helps).
 */
export function toReplaceCuesPayload(parsed: Pick<DerivedCues, "cues">): ReplaceCue[] {
  return parsed.cues.map((cue, index) => ({
    artistsText: cue.artistsText,
    ...(cue.findingId !== undefined ? { findingId: cue.findingId } : {}),
    position: index + 1,
    titleText: cue.titleText,
  }));
}
