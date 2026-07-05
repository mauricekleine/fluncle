// The pulse wire contract — the envelopes the daemon serialises to the glass.
// Types only; importing this pulls no runtime into either bundle. The row/leaf
// shapes live in logic.ts (the pure core); this file assembles them into the
// three responses the panel reads: the board, the next-to-post card, and the
// nudge check.

import { type MachineId } from "../../contract";
import { type NudgeDecision, type NudgeReason, type QueueRow, type SurfaceRow } from "./logic";

/** The daemon's own vitals (the pulse-lite reference, folded in). */
export type PulseVitals = {
  adminTokenAboard: boolean;
  machine: MachineId;
  machineBrand: string;
  pid: number;
  port: number;
  uptimeMs: number;
  version: string;
};

/** Whether the show is up on this machine — read-only GETs to :4173 / :4180. */
export type LiveProbe = {
  bridge: "down" | "up";
  glass: "down" | "up";
};

/** The render queue section (findings awaiting the camera), oldest first. */
export type QueueSummary = {
  error?: string;
  rows: QueueRow[];
};

/** The public /api/status probe, trimmed to the board's surface grid. */
export type SurfacesSummary = {
  error?: string;
  freshestReportAt: string | null;
  rows: SurfaceRow[];
};

/** GET /api/pulse/board — the cheap, fast-polled half of the board. */
export type PulseBoard = {
  live: LiveProbe;
  queue: QueueSummary;
  surfaces: SurfacesSummary;
  vitals: PulseVitals;
};

/** The single next-to-post card: everything the operator needs to post it by hand. */
export type NextToPostCard = {
  addedAt: string;
  ageMinutes: number;
  /** The finding's admin board — where the real push + status controls live. */
  adminUrl: string;
  artistTitle: string;
  /** The bundle caption (note.txt) to paste at post time, or null if none on file. */
  caption: string | null;
  coverUrl?: string;
  logId: string;
  /** The finding's public log page. */
  logUrl: string;
  /** The portrait social cut to attach (found.fluncle.com/<logId>/footage.social.mp4). */
  postAssetUrl: string;
  title: string;
};

/** The nudge's live status — what the panel shows and what the check returns dry. */
export type NudgeStatus = {
  ageMs: number | null;
  hasUnposted: boolean;
  lastNudgeDay: string | null;
  newestPostedAt: number | null;
  reason: NudgeReason;
  thresholdHours: number;
  timeZone: string;
  wouldFire: boolean;
};

/** GET /api/pulse/next — the next-to-post card plus the nudge status. */
export type PulseNext = {
  error?: string;
  nextToPost?: NextToPostCard;
  nudge: NudgeStatus;
};

/** POST /api/pulse/nudge/check — the real tick, optionally fired. */
export type NudgeCheckResponse = {
  decision: NudgeDecision;
  notified: boolean;
};
