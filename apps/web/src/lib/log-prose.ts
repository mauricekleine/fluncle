// The log page's definitional language, written once: the meta description, the
// visible definitional block, and the MusicRecording JSON-LD description all read
// from here, so the schema mirrors the visible prose by construction (schema that
// contradicts the page gets discounted).

import { formatDateLong } from "./format";
import { GALAXIES, type Galaxy } from "./galaxies";

/**
 * The editorial note's length budget. A note is SEO/AEO fuel, not a free-text
 * field: it lands inside the definitional prose + JSON-LD, so it stays a tight
 * one-or-two-sentence take rather than an essay. Enforced in the board dialog
 * (textarea) and the admin PATCH validator.
 */
export const NOTE_MAX_LENGTH = 280;

export type LogProseInput = {
  addedAt: string;
  artists: string[];
  /** Stored telemetry, woven into the visible prose when present (all optional). */
  bpm?: number;
  galaxy?: { key: Galaxy; name: string };
  key?: string;
  label?: string;
  logId: string;
  /** The editorial "why" — woven into the prose (and thus JSON-LD) when present. */
  note?: string;
  releaseDate?: string;
  title: string;
};

/** Tracklist convention: `Artist — Title` (the one sanctioned em dash). */
export function artistTitleLine(track: { artists: string[]; title: string }): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

/**
 * The CONCISE definitional line — the meta / OG / Twitter description. Kept tight
 * (the differentiator + one telemetry keyword) so it reads cleanly in a SERP, in
 * the proven `[Entity] is a [category] that [differentiator]` shape with the
 * coordinate as the subject.
 */
export function definitionalSentences(track: LogProseInput): string {
  const tempo = track.bpm ? `${Math.round(track.bpm)} BPM ` : "";

  return `${track.logId} is Fluncle's Log ID for ${artistTitleLine(track)}: a ${tempo}drum & bass banger found ${formatDateLong(track.addedAt)}. fluncle://${track.logId}.`;
}

/**
 * The RICHER visible block (and the JSON-LD description, which mirrors it): the
 * definitional line plus whatever stored telemetry the finding carries — tempo,
 * key, label, release year, and its vibe-map galaxy. Every clause is conditional,
 * so an un-enriched or un-tagged finding degrades to the bare definition cleanly.
 */
export function definitionalProse(track: LogProseInput): string {
  const sentences = [
    `${track.logId} is Fluncle's Log ID for ${artistTitleLine(track)}, a drum & bass banger found ${formatDateLong(track.addedAt)}.`,
  ];

  const tempoKey =
    track.bpm && track.key
      ? `${Math.round(track.bpm)} BPM in ${track.key}`
      : track.bpm
        ? `${Math.round(track.bpm)} BPM`
        : track.key
          ? `in ${track.key}`
          : undefined;
  if (tempoKey) {
    sentences.push(track.bpm ? `It rolls at ${tempoKey}.` : `It's ${tempoKey}.`);
  }

  const year = track.releaseDate?.slice(0, 4);
  const release =
    track.label && year
      ? `Released on ${track.label} in ${year}.`
      : track.label
        ? `Released on ${track.label}.`
        : year
          ? `Released in ${year}.`
          : undefined;
  if (release) {
    sentences.push(release);
  }

  if (track.galaxy) {
    const meta = GALAXIES[track.galaxy.key];
    sentences.push(
      `It sits in the ${track.galaxy.name} galaxy — the ${meta.energy}, ${meta.mood} quarter of Fluncle's vibe map.`,
    );
  }

  // The editorial note (the human "why") rides here — the one finding-specific
  // line that makes this page's prose unlike any other's. Dropped in verbatim
  // (it's already in Fluncle's voice), with terminal punctuation ensured so it
  // reads as its own sentence before the coordinate closer.
  const note = track.note?.trim();
  if (note) {
    const sentence = note[0].toUpperCase() + note.slice(1);
    sentences.push(/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`);
  }

  sentences.push(
    `The coordinate fluncle://${track.logId} names this finding on every surface of the Galaxy — the web log, the RSS feed, and the fluncle CLI.`,
  );

  return sentences.join(" ");
}

/** The coordinate split for the decode block: `004` + `7.2I`. */
export function splitLogId(logId: string): { sector: string; tail: string } {
  const dot = logId.indexOf(".");

  return { sector: logId.slice(0, dot), tail: logId.slice(dot + 1) };
}
