// Pure helpers that turn a mixtape's cued members into the per-platform metadata
// distribution needs: YouTube description chapters and Mixcloud `sections[]`, from
// one pass. Plus the description builders (the dream note + the external-only
// `fluncle://<logId>` breadcrumb). No I/O — unit-tested in mixtape-chapters.test.ts.

import { type MixtapeMember } from "@fluncle/contracts";
import { type MixcloudSection, mixcloudSections } from "@fluncle/contracts/util";

export type MixtapeChapters = {
  /** Cued members (have a startMs) — the ones that could be placed on a timeline. */
  cuedCount: number;
  mixcloudSections: MixcloudSection[];
  /** All members, cued or not. */
  totalCount: number;
  /** The YouTube description chapter block, or null if fewer than 3 valid chapters. */
  youtubeChapters: string | null;
};

// YouTube requires ≥3 chapters, the first at 0:00, each ≥10s after the prior, or it
// ignores the whole set. We honor that exactly; a cue that violates the 10s spacing
// is dropped rather than nudged (a wrong timestamp is worse than one fewer chapter).
const MIN_CHAPTERS = 3;
const MIN_CHAPTER_GAP_S = 10;

const artistOf = (member: MixtapeMember): string => member.artists.join(", ");

/** `m:ss`, or `h:mm:ss` once past an hour (YouTube/standard tracklist convention). */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }

  return `${minutes}:${ss}`;
}

export function mixtapeChapters(members: MixtapeMember[]): MixtapeChapters {
  const cued = members
    .filter((member): member is MixtapeMember & { startMs: number } => member.startMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  // Mixcloud: every cued member, no spacing rule, integer-second offsets — the shared
  // derivation (byte-identical to the CLI upload + the server-side re-sync edit).
  const sections = mixcloudSections(members);

  // YouTube: force the first chapter to 0:00, then keep only members ≥10s after the
  // prior kept one.
  const lines: string[] = [];
  let prevSeconds = -MIN_CHAPTER_GAP_S;

  cued.forEach((member, index) => {
    const seconds = index === 0 ? 0 : Math.floor(member.startMs / 1000);

    if (seconds - prevSeconds < MIN_CHAPTER_GAP_S) {
      return;
    }

    prevSeconds = seconds;
    lines.push(`${formatTimestamp(seconds)} ${artistOf(member)} - ${member.title}`);
  });

  return {
    cuedCount: cued.length,
    mixcloudSections: sections,
    totalCount: members.length,
    youtubeChapters: lines.length >= MIN_CHAPTERS ? lines.join("\n") : null,
  };
}

/**
 * The base description for any external platform: the dream note plus the
 * `fluncle://<logId>` spine breadcrumb. The marker is EXTERNAL-ONLY — never stored
 * in the note column, never shown on /log (the coordinate is the mixtape's identity
 * there already). Appended only when building a platform description at upload.
 */
export function mixtapeDescription(note: string, logId: string): string {
  return `${note.trim()}\n\nfluncle://${logId}`;
}

/**
 * The full YouTube video description: the base description (note + breadcrumb)
 * followed by the chapter block when there is one.
 */
export function youtubeDescription(note: string, logId: string, members: MixtapeMember[]): string {
  const base = mixtapeDescription(note, logId);
  const { youtubeChapters } = mixtapeChapters(members);

  return youtubeChapters ? `${base}\n\n${youtubeChapters}` : base;
}
