// The show's pre-flight, folded into a live checklist. `bun run … show` narrates
// its boot in the pre-flight vocabulary (packages/live/src/show.ts): each NAMED
// check is `line(status, label.padEnd(22), note)` → `  [token] label   note`, and
// everything else is plain narration or a one-off `[token] sentence` (no note).
// This reducer folds a run's output lines into { the checklist, the phase, the
// live flags } — pure, so the parse + the phase machine are unit-tested against
// real fixture lines. It reuses the drawer's `parseStatusLine` (one token grammar,
// no second copy).

import { parseStatusLine, type StatusToken } from "../../ui/status-line";

/** One named pre-flight check: a stable label, its latest token, and its detail note. */
export type ShowCheck = {
  label: string;
  note: string;
  token: StatusToken;
};

/** Where the rig is, read off the run so far. Priority: down > live > holding > clear > reading. */
export type ShowPhase = "clear" | "down" | "holding" | "idle" | "live" | "reading";

export type ShowProgress = {
  /** The bridge's state socket answered — the phone remote is reachable. */
  bridgeLive: boolean;
  /** The named checks, in first-seen order, each carrying its latest status. */
  checks: ShowCheck[];
  /** The glass is serving — the show reached "the glass is up". */
  glassLive: boolean;
  /** How many checks are currently holding — the count behind the "depart anyway" affordance. */
  holds: number;
  phase: ShowPhase;
};

/**
 * The canonical pre-flight order (packages/live/src/show.ts). The panel renders this
 * as a stable skeleton and fills each row from the run — so the checklist reads the same
 * before the first line lands and after the last.
 */
export const EXPECTED_CHECKS = [
  "audio meter",
  "sample rate",
  "disk headroom",
  "ports",
  "state socket",
  "glass",
] as const;

/**
 * Read one output line as a NAMED check — a token row that carries a detail note (the
 * `line()` signature: `label.padEnd(22)` leaves a 2+-space gap before the note). A one-off
 * `[token] sentence` from `say()` has no note and is narration, not a check — it stays in
 * the log. Pure.
 */
export function parseNamedCheck(text: string): ShowCheck | undefined {
  const row = parseStatusLine(text);

  if (!row || row.note.length === 0) {
    return undefined;
  }

  return { label: row.label, note: row.note, token: row.token };
}

/** The current status of one check by label, or undefined if it hasn't reported yet. */
export function checkByLabel(progress: ShowProgress, label: string): ShowCheck | undefined {
  return progress.checks.find((check) => check.label === label);
}

/** Fold a run's output lines (arrival order) into the checklist + phase. */
export function readShowProgress(lines: readonly string[]): ShowProgress {
  const byLabel = new Map<string, ShowCheck>();
  const order: string[] = [];

  let sawReading = false;
  let sawClear = false;
  let sawHolding = false;
  let sawGlassUp = false;
  let sawDown = false;

  for (const text of lines) {
    const check = parseNamedCheck(text);

    if (check) {
      if (!byLabel.has(check.label)) {
        order.push(check.label);
      }

      byLabel.set(check.label, check);
      continue;
    }

    if (/pre-flight — reading the rig/.test(text)) {
      sawReading = true;
    }

    if (/not clear to depart|Clear the blockers/.test(text)) {
      sawHolding = true;
    }

    if (/all clear\. The rig reads good|clear to depart/.test(text)) {
      sawClear = true;
    }

    if (/the glass is up\b/.test(text)) {
      sawGlassUp = true;
    }

    if (/standing the rig down|the glass is dark|crew stood down/.test(text)) {
      sawDown = true;
    }
  }

  const checks = order.flatMap((label) => {
    const check = byLabel.get(label);

    return check ? [check] : [];
  });
  const holds = checks.filter((check) => check.token === "hold").length;
  const glassLive = sawGlassUp || byLabel.get("glass")?.token === "clear";
  const bridgeLive = byLabel.get("state socket")?.token === "clear";

  const phase: ShowPhase = sawDown
    ? "down"
    : glassLive
      ? "live"
      : holds > 0 || sawHolding
        ? "holding"
        : sawClear
          ? "clear"
          : sawReading || checks.length > 0
            ? "reading"
            : "idle";

  return { bridgeLive, checks, glassLive, holds, phase };
}
