// The log page's definitional language, written once: the meta description, the
// visible definitional block, and the MusicRecording JSON-LD description all read
// from here, so the schema mirrors the visible prose by construction (schema that
// contradicts the page gets discounted).

import { formatDateLong } from "./format";

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
  /**
   * The finding's sonic galaxy (browse-by-feel RFC): the operator-named cluster over
   * the MuQ embedding space, read from `tracks.galaxy_id`. Present ONLY when placed AND
   * named AND the public launch gate is open (the loader passes it through only then);
   * `slug` links the visible clause to `/galaxies/<slug>`. Replaces the dead
   * vibe-quadrant `{ key, name }` shape (the four-quarter mood map is retired).
   */
  galaxy?: { name: string; slug: string };
  key?: string;
  label?: string;
  /**
   * The `/label/<slug>` the imprint has, when the label entity exists (`tracks.label_id`).
   * Present → the release clause names the label as a GRAPH LINK; absent → the same clause
   * reads as plain text. The JSON-LD / meta mirror reads it plain either way.
   */
  labelSlug?: string;
  logId: string;
  /** The editorial "why" — woven into the prose (and thus JSON-LD) when present. */
  note?: string;
  releaseDate?: string;
  title: string;
};

/**
 * A definitional-prose segment: plain text, or the galaxy clause carrying the entity so
 * the VISIBLE render can linkify the galaxy name while the JSON-LD / meta description
 * read the SAME text plain. The mirror ("schema mirrors the visible prose") holds by
 * construction — `definitionalProse` is these segments joined, and the visible block
 * renders the same segments.
 */
export type ProseSegment =
  | { kind: "galaxy"; name: string; slug: string }
  | { kind: "label"; name: string; slug: string; tail: string }
  | { kind: "text"; text: string };

/** The galaxy clause, split so the name (with " galaxy") is a single linkable token. */
export const GALAXY_CLAUSE_LEAD = "It sits in the ";
export const GALAXY_CLAUSE_TAIL = ", with the findings that hit the same way.";

/**
 * The release clause's lead, split so the imprint's NAME is a single linkable token — the
 * galaxy clause's trick, applied to the label. The clause's tail varies (" in 2016." or just
 * "."), so it rides on the segment rather than a constant.
 */
export const LABEL_CLAUSE_LEAD = "Released on ";

/** The galaxy clause's link text — the name plus the noun, the whole phrase links. */
export function galaxyClauseLinkText(name: string): string {
  return `${name} galaxy`;
}

/** The galaxy clause as plain text (the JSON-LD / meta mirror of the visible clause). */
function galaxyClauseText(name: string): string {
  return `${GALAXY_CLAUSE_LEAD}${galaxyClauseLinkText(name)}${GALAXY_CLAUSE_TAIL}`;
}

/** The release clause as plain text (the JSON-LD / meta mirror of the visible clause). */
function labelClauseText(name: string, tail: string): string {
  return `${LABEL_CLAUSE_LEAD}${name}${tail}`;
}

/** The plain text of one segment — the join unit behind `definitionalProse`. */
function segmentText(segment: ProseSegment): string {
  if (segment.kind === "galaxy") {
    return galaxyClauseText(segment.name);
  }

  if (segment.kind === "label") {
    return labelClauseText(segment.name, segment.tail);
  }

  return segment.text;
}

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
 * The RICHER visible block as ordered SEGMENTS (browse-by-feel RFC): the definitional
 * line plus whatever stored telemetry the finding carries — tempo, key, label, release
 * year, and its sonic galaxy — then the note and the coordinate closer. Every clause is
 * conditional, so an un-enriched or unplaced finding degrades to the bare definition
 * cleanly. The galaxy clause is its own segment carrying the entity, so the visible
 * render links the name to `/galaxies/<slug>` while the JSON-LD reads the same text
 * plain. `definitionalProse` is these segments joined — the mirror holds by construction.
 */
export function definitionalProseSegments(track: LogProseInput): ProseSegment[] {
  const segments: ProseSegment[] = [
    {
      kind: "text",
      text: `${track.logId} is Fluncle's Log ID for ${artistTitleLine(track)}, a drum & bass banger found ${formatDateLong(track.addedAt)}.`,
    },
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
    segments.push({
      kind: "text",
      text: track.bpm ? `It rolls at ${tempoKey}.` : `It's ${tempoKey}.`,
    });
  }

  // The release clause. When the imprint has a `/label/<slug>` page, its NAME is its own
  // segment so the visible render can linkify it (the galaxy clause's mechanism, applied to
  // the label) while the JSON-LD / meta description read the same sentence plain. A label with
  // no entity page — and a bare year — stay flat text: there is nowhere honest to send you.
  const year = track.releaseDate?.slice(0, 4);
  if (track.label && track.labelSlug) {
    segments.push({
      kind: "label",
      name: track.label,
      slug: track.labelSlug,
      tail: year ? ` in ${year}.` : ".",
    });
  } else {
    const release =
      track.label && year
        ? `Released on ${track.label} in ${year}.`
        : track.label
          ? `Released on ${track.label}.`
          : year
            ? `Released in ${year}.`
            : undefined;

    if (release) {
      segments.push({ kind: "text", text: release });
    }
  }

  if (track.galaxy) {
    segments.push({ kind: "galaxy", name: track.galaxy.name, slug: track.galaxy.slug });
  }

  // The editorial note (the human "why") rides here — the one finding-specific
  // line that makes this page's prose unlike any other's. Dropped in verbatim
  // (it's already in Fluncle's voice), with terminal punctuation ensured so it
  // reads as its own sentence before the coordinate closer.
  const note = track.note?.trim();
  if (note) {
    const sentence = note.charAt(0).toUpperCase() + note.slice(1);
    segments.push({ kind: "text", text: /[.!?…]$/.test(sentence) ? sentence : `${sentence}.` });
  }

  segments.push({
    kind: "text",
    text: `The coordinate fluncle://${track.logId} names this finding on every surface of the Galaxy: the web log, the RSS feed, and the fluncle CLI.`,
  });

  return segments;
}

/**
 * The RICHER visible block as one string — the JSON-LD description + the fallback plain
 * render. Mirrors the visible segments by construction (it IS the segments joined).
 */
export function definitionalProse(track: LogProseInput): string {
  return definitionalProseSegments(track).map(segmentText).join(" ");
}

/** The coordinate split for the decode block: `004` + `7.2I`. */
export function splitLogId(logId: string): { sector: string; tail: string } {
  const dot = logId.indexOf(".");

  return { sector: logId.slice(0, dot), tail: logId.slice(dot + 1) };
}
