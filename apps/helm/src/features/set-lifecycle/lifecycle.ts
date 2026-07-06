// The lifecycle model — pure, shared by the server (the shelf read) and the panel
// (the board render), pinned by lifecycle.test.ts. A recording's stage on the
// spine is read off the DTO, never re-derived from a nullable key:
//
//   plan     — a videoless recording (no set video yet): the lined-up findings.
//   take     — a captured set (owns a set video), not yet promoted.
//   promoted — a take that minted a mixtape (carries the F-marked Log ID).
//
// Progression is one-way (plan → take → promoted); the board lays it out that way.

import { type FeatureMachine, type MachineId } from "../../contract";

/**
 * The recording shape the shelf renders — the fields of `@fluncle/contracts`'
 * RecordingDTO this feature actually reads (a structural subset so the panel and
 * the daemon share one type without pulling the whole contracts package in).
 */
export type Recording = {
  createdAt: string;
  durationMs?: number;
  /** "has video" = the recording owns a set-video key (a TAKE); a PLAN has none. */
  hasVideo: boolean;
  id: string;
  /** The promoted mixtape's committed Log ID coordinate — present once promoted. */
  logId?: string;
  mixtapeId?: string;
  parentId?: string;
  plannedFor?: string;
  recordedAt?: string;
  title: string;
  /** The cue count is all the board needs off the tracklist. */
  tracklist?: unknown[];
  updatedAt: string;
  /** The display label ("v2") among a plan's takes. */
  version: number;
};

export type Stage = "plan" | "promoted" | "take";

/** The stages in spine order — the board's lanes, left to right. */
export const STAGE_ORDER: Stage[] = ["plan", "take", "promoted"];

/** The deadpan token + human label each lane wears (the show.ts vocabulary). */
export const STAGE_META: Record<Stage, { blurb: string; label: string; token: string }> = {
  plan: { blurb: "Findings lined up. No video yet.", label: "Plan", token: "plan" },
  promoted: { blurb: "A mixtape was minted from it.", label: "Promoted", token: "F" },
  take: { blurb: "A captured set. Not promoted yet.", label: "Take", token: "take" },
};

/** Which stage a recording sits at — logId wins, then video presence. */
export function stageOf(recording: Pick<Recording, "hasVideo" | "logId">): Stage {
  if (recording.logId !== undefined && recording.logId.length > 0) {
    return "promoted";
  }

  if (recording.hasVideo) {
    return "take";
  }

  return "plan";
}

export type StageGroups = Record<Stage, Recording[]>;

/**
 * Group the shelf into its three lanes, newest first within each (the API already
 * lists newest-first; this preserves that order per lane).
 */
export function groupByStage(recordings: readonly Recording[]): StageGroups {
  const groups: StageGroups = { plan: [], promoted: [], take: [] };

  for (const recording of recordings) {
    groups[stageOf(recording)].push(recording);
  }

  return groups;
}

/**
 * Whether an action tied to `target` may run on `machine`. An unknown machine is
 * never locked out (it sees + runs everything — the operator knows their rig, the
 * header badge says "unknown"); a known machine runs only its own actions. This is
 * the action-level twin of the manifest gating in features/gating.ts.
 */
export function canRunOn(machine: MachineId, target: FeatureMachine): boolean {
  return machine === "unknown" || machine === target;
}

/** The cue count for a recording (0 when the tracklist is absent). */
export function cueCount(recording: Pick<Recording, "tracklist">): number {
  return recording.tracklist?.length ?? 0;
}
