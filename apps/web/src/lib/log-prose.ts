// The log page's definitional language, written once: the meta description,
// the visible definitional block, and the MusicRecording JSON-LD description
// all read from here, so the schema mirrors the visible prose by construction
// (schema that contradicts the page gets discounted).

import { formatDateLong } from "./format";

export type LogProseInput = {
  addedAt: string;
  artists: string[];
  logId: string;
  title: string;
};

/** Tracklist convention: `Artist — Title` (the one sanctioned em dash). */
export function artistTitleLine(track: { artists: string[]; title: string }): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * The definitional block in the proven `[Entity] is a [category] that
 * [differentiator]` shape: the coordinate as the subject, in both forms.
 */
export function definitionalSentences(track: LogProseInput): string {
  return `${track.logId} is Fluncle's Log ID for ${artistTitleLine(track)}: a drum & bass banger found ${formatDateLong(track.addedAt)}. The full coordinate, fluncle://${track.logId}, names this finding on every surface of the Galaxy.`;
}

/** The coordinate split for the decode block: `004` + `7.2I`. */
export function splitLogId(logId: string): { sector: string; tail: string } {
  const dot = logId.indexOf(".");

  return { sector: logId.slice(0, dot), tail: logId.slice(dot + 1) };
}
