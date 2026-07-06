// The picker's data model — the tracklists the operator can raise the glass on,
// mapped from the Fluncle admin API to a flat, sortable choice list. Pure, so the
// plan/take/mixtape mapping + the de-dup + the ordering are unit-tested without the
// network.
//
// What `bun run --cwd packages/live show --plan <ref>` actually resolves
// (packages/live/src/bridge/plan.ts): a PLAN by its galaxy-slug HANDLE (a videoless
// recording — `hasVideo === false` — whose title IS the handle), or a MIXTAPE/finding
// COORDINATE (a Log ID like `019.F.1A`). So a choice's `ref` is the plan handle or the
// Log ID; nothing else is raisable. A raw TAKE (a recording that owns a set video) has
// neither a handle the bridge accepts nor — until promoted — a coordinate, so an
// un-promoted take is not a tracklist you can raise; a PROMOTED take IS its mixtape and
// is listed once, as that mixtape.

import { type MixtapeDTO, type RecordingDTO } from "@fluncle/contracts";

/** How the chosen tracklist reaches the show: a plan handle, a promoted take, or a mixtape coordinate. */
export type ShowChoiceKind = "mixtape" | "plan" | "take";

/** One row in the picker. `ref` is the `--plan` value; `handle` is what the row shows as its identity. */
export type ShowChoice = {
  count: number;
  countLabel: string;
  handle: string;
  kind: ShowChoiceKind;
  recordedAt: string | null;
  ref: string;
  title: string;
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Milliseconds for an ISO date, or 0 (sorts last) for a missing/unparseable one. */
function dateMs(iso: string | null): number {
  if (iso === null) {
    return 0;
  }

  const ms = Date.parse(iso);

  return Number.isFinite(ms) ? ms : 0;
}

/** Newest first; a missing date sinks to the bottom, ties break on the shown handle. */
function byRecency(a: ShowChoice, b: ShowChoice): number {
  return dateMs(b.recordedAt) - dateMs(a.recordedAt) || a.handle.localeCompare(b.handle);
}

/** A PLAN — a videoless recording. Its galaxy-slug title IS the `--plan` handle (the normal live flow). */
export function planToChoice(recording: RecordingDTO): ShowChoice {
  return {
    count: recording.tracklist.length,
    countLabel: pluralize(recording.tracklist.length, "cue"),
    handle: recording.title,
    kind: "plan",
    recordedAt: recording.plannedFor ?? recording.recordedAt ?? recording.createdAt,
    ref: recording.title,
    title: recording.title,
  };
}

/** A promoted TAKE — a recording that owns a set video AND carries a Log ID (raise by that coordinate). */
export function takeToChoice(recording: RecordingDTO, logId: string): ShowChoice {
  return {
    count: recording.tracklist.length,
    countLabel: pluralize(recording.tracklist.length, "cue"),
    handle: logId,
    kind: "take",
    recordedAt: recording.recordedAt ?? recording.createdAt,
    ref: logId,
    title: recording.title,
  };
}

/** A published MIXTAPE — raise by its Log ID coordinate; the count is its frozen member set. */
export function mixtapeToChoice(mixtape: MixtapeDTO, logId: string): ShowChoice {
  return {
    count: mixtape.memberCount,
    countLabel: pluralize(mixtape.memberCount, "track"),
    handle: logId,
    kind: "mixtape",
    recordedAt: mixtape.recordedAt ?? mixtape.publishedAt ?? mixtape.createdAt ?? null,
    ref: logId,
    title: mixtape.title,
  };
}

/**
 * The full picker list, grouped by kind (plans → mixtapes → standalone promoted takes)
 * and newest-first within each group. A promoted take whose Log ID already appears as a
 * mixtape is dropped (the mixtape represents it); an un-promoted take (no coordinate) is
 * dropped too — it is not a raisable tracklist.
 */
export function buildChoices(
  recordings: readonly RecordingDTO[],
  mixtapes: readonly MixtapeDTO[],
): ShowChoice[] {
  const mixtapeChoices: ShowChoice[] = [];
  const mixtapeRefs = new Set<string>();

  for (const mixtape of mixtapes) {
    if (mixtape.logId === undefined) {
      continue; // not minted — no coordinate to raise on
    }

    mixtapeChoices.push(mixtapeToChoice(mixtape, mixtape.logId));
    mixtapeRefs.add(mixtape.logId);
  }

  const planChoices: ShowChoice[] = [];
  const takeChoices: ShowChoice[] = [];

  for (const recording of recordings) {
    if (!recording.hasVideo) {
      planChoices.push(planToChoice(recording));
      continue;
    }

    // A take is raisable only once promoted, and only if its mixtape isn't already listed.
    if (recording.logId !== undefined && !mixtapeRefs.has(recording.logId)) {
      takeChoices.push(takeToChoice(recording, recording.logId));
    }
  }

  return [
    ...planChoices.sort(byRecency),
    ...mixtapeChoices.sort(byRecency),
    ...takeChoices.sort(byRecency),
  ];
}
