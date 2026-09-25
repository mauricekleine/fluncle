import { formatDateLong } from "./format";

export const NOTE_MAX_LENGTH = 280;

export type LogProseInput = {
  addedAt: string;
  artists: string[];

  bpm?: number;

  galaxy?: { name: string; slug: string };
  key?: string;
  label?: string;

  labelSlug?: string;
  logId: string;

  note?: string;
  releaseDate?: string;
  title: string;
};

export type ProseSegment =
  | { kind: "galaxy"; name: string; slug: string }
  | { kind: "label"; name: string; slug: string; tail: string }
  | { kind: "text"; text: string };

export const GALAXY_CLAUSE_LEAD = "It sits in the ";
export const GALAXY_CLAUSE_TAIL = ", with the findings that hit the same way.";

export const LABEL_CLAUSE_LEAD = "Released on ";

export function galaxyClauseLinkText(name: string): string {
  return `${name} galaxy`;
}

function galaxyClauseText(name: string): string {
  return `${GALAXY_CLAUSE_LEAD}${galaxyClauseLinkText(name)}${GALAXY_CLAUSE_TAIL}`;
}

function labelClauseText(name: string, tail: string): string {
  return `${LABEL_CLAUSE_LEAD}${name}${tail}`;
}

function segmentText(segment: ProseSegment): string {
  if (segment.kind === "galaxy") {
    return galaxyClauseText(segment.name);
  }

  if (segment.kind === "label") {
    return labelClauseText(segment.name, segment.tail);
  }

  return segment.text;
}

export function artistTitleLine(track: { artists: string[]; title: string }): string {
  return `${track.artists.join(", ")} — ${track.title}`;
}

export function definitionalSentences(track: LogProseInput): string {
  const tempo = track.bpm ? `${Math.round(track.bpm)} BPM ` : "";

  return `${track.logId} is Fluncle's Log ID for ${artistTitleLine(track)}: a ${tempo}drum & bass banger found ${formatDateLong(track.addedAt)}. fluncle://${track.logId}.`;
}

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

export function definitionalProse(track: LogProseInput): string {
  return definitionalProseSegments(track).map(segmentText).join(" ");
}

export function splitLogId(logId: string): { sector: string; tail: string } {
  const dot = logId.indexOf(".");

  return { sector: logId.slice(0, dot), tail: logId.slice(dot + 1) };
}
