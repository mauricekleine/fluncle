// THE GRAPH ENTITIES' OWN OPENING LINES — written once, read twice.
//
// Fluncle's archive is a graph: log ↔ artist ↔ label ↔ album ↔ galaxy. Each of the four
// non-log nodes has a page, and each page opens with ONE first-person line framing Fluncle's
// relationship to it ("I pulled my first tune off Hoofbeats Music on Jun 12, 2026, and I've
// logged 3 off the imprint since.").
//
// That line now has TWO readers: the entity's own page masthead, and the GraphLink hover card
// that previews the entity from anywhere else in the app. They MUST be the same sentence — a
// card that paraphrased the page would be a second, drifting voice for the same object. So the
// builders live here, pure, and both callers import them. The card carries the page's own line
// BY CONSTRUCTION; there is no second copy to keep in sync (`log-prose.ts` is the precedent —
// same trick, for the definitional prose the JSON-LD mirrors).
//
// VOICE.md: first person, said-not-written, active. Fluncle frames HIS relationship to the
// entity — never a fabricated bio, never a claim about the music he has not made. The counts
// are FINDINGS only: the uncertified rows on those pages are never introduced, never named,
// and never counted aloud (DESIGN.md's Unlit Rule).

import { formatDateLong } from "./format";

/** The four non-log nodes of the graph — the entities a GraphLink can name. */
export type GraphEntityKind = "album" | "artist" | "galaxy" | "label";

/** What a hover card (and the SSH/CLI surfaces, later) needs to preview an entity. */
export type GraphPreview = {
  /** Up to a handful of finding covers — the card's visual proof. */
  covers: string[];
  /** FINDINGS only (never the unlit catalogue rows). */
  findingCount: number;
  kind: GraphEntityKind;
  /** The entity page's OWN opening line. Not a summary of it — it. */
  line: string;
  name: string;
  slug: string;
};

/**
 * The artist page's opening line. When Fluncle has a first-found date it opens the dossier the
 * logbook way ("first crossed his path on …"); the bare-count line is the pre-dossier fallback.
 */
export function artistSignatureLine(
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string {
  if (findingCount === 0) {
    return "Nothing logged from this one yet.";
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "I've found just one of their tunes so far. Play it loud."
      : `I've found ${findingCount} of their tunes so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I first crossed ${name}'s path on ${when}. Just the one so far. Play it loud.`;
  }

  return `I first crossed ${name}'s path on ${when}, and I've logged ${findingCount} of their tunes since. Have a dig.`;
}

/** The label page's opening line — Fluncle's relationship to the imprint. */
export function labelSignatureLine(
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string {
  if (findingCount === 0) {
    return "Nothing logged off this one yet.";
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "One tune off this imprint so far. Play it loud."
      : `${findingCount} tunes off this imprint so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I pulled my first tune off ${name} on ${when}. Just the one so far. Play it loud.`;
  }

  return `I pulled my first tune off ${name} on ${when}, and I've logged ${findingCount} off the imprint since. Have a dig.`;
}

/** The album page's opening line — Fluncle's relationship to the record. */
export function albumSignatureLine(
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string {
  if (findingCount === 0) {
    return "Nothing logged off this one yet.";
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "One tune off this record so far. Play it loud."
      : `${findingCount} tunes off this record so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I pulled my first tune off ${name} on ${when}. Just the one so far. Play it loud.`;
  }

  return `I pulled my first tune off ${name} on ${when}, and I've logged ${findingCount} off it since. Have a dig.`;
}

/**
 * The galaxy lens page's opening line (the Garnish Rule — a real relation with cosmos trim,
 * never a genre claim): what the region IS, said not written, no k-means jargon.
 */
export function galaxyIntroLine(findingCount: number): string {
  if (findingCount === 1) {
    return "One finding out here so far, and everything near it in sound.";
  }

  return `${findingCount} findings that hit the same way, core of the galaxy first.`;
}

/**
 * The one opening line for any entity, dispatched by kind. The GraphLink hover card reads
 * THIS; each entity page reads its own builder above directly (it already holds the richer
 * inputs). Same functions either way — the card can never drift from the page.
 */
export function graphSignatureLine(
  kind: GraphEntityKind,
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string {
  switch (kind) {
    case "album": {
      return albumSignatureLine(name, findingCount, firstFoundAt);
    }
    case "artist": {
      return artistSignatureLine(name, findingCount, firstFoundAt);
    }
    case "galaxy": {
      return galaxyIntroLine(findingCount);
    }
    case "label": {
      return labelSignatureLine(name, findingCount, firstFoundAt);
    }
  }
}

/**
 * The earliest `addedAt` across a set of findings — the "first found" date the signature lines
 * open on. Pure over data the entity pages have already loaded, so it costs no extra query.
 */
export function firstFoundAt(findings: { addedAt?: string }[]): string | undefined {
  return findings
    .map((finding) => finding.addedAt)
    .filter((addedAt): addedAt is string => Boolean(addedAt))
    .sort()[0];
}
