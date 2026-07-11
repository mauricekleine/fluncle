// THE GRAPH ENTITIES' OWN OPENING LINES — written once, read twice.
//
// Fluncle's archive is a graph: log ↔ artist ↔ label ↔ album ↔ galaxy. Each of the four
// non-log nodes has a page, and each page opens with ONE first-person line framing Fluncle's
// relationship to it ("I pulled my first tune off Hoofbeats Music on Jun 12, 2026, and I'm up
// to 3 findings on this label now.").
//
// That line has TWO readers: the entity's own page masthead, and the GraphLink hover card that
// previews the entity from anywhere else in the app. They MUST be the same sentence — a card
// that paraphrased the page would be a second, drifting voice for the same object. So the
// builders live here, pure, and both callers import them. The card carries the page's own line
// BY CONSTRUCTION; there is no second copy to keep in sync (`log-prose.ts` is the precedent —
// same trick, for the definitional prose the JSON-LD mirrors).
//
// VOICE.md: first person, said-not-written, active. Fluncle frames HIS relationship to the
// entity — never a fabricated bio, never a claim about the music he has not made. The counts
// are FINDINGS only: the uncertified rows on those pages are never introduced, never named,
// and never counted aloud (DESIGN.md's Unlit Rule).
//
// ── TWO RULES THAT BIND EVERY LINE BELOW ────────────────────────────────────────────────
//
// 1. NOTHING FOUND YET ⇒ NO LINE (`undefined`). Fluncle has nothing to say about a label he
//    has never pulled a tune off, so he says nothing, and the masthead is just the name. These
//    used to return "Nothing logged off this one yet." — an apology for the absent half of the
//    page, and an apology is still a CLAIM: it told a crawler the page was ABOUT findings and
//    then had none, which is the definition of a doorway page. A crawler-discovered label with
//    700 releases is a real page about a label; it is not a broken findings page. The callers
//    render the line conditionally (docs/album-entity.md).
//
// 2. "IMPRINT" IS OUT OF THE VOCABULARY. It is trade-press English, not something the uncle
//    says out loud. It is a label. Nothing on any surface says "off this imprint" — and the
//    count noun the hover card prints (graph-link.tsx) is "on this label" for the same reason.
//    `graph-prose.test.ts` pins both rules.

import { findingsCount, formatDateLong } from "./format";

/** The four non-log nodes of the graph — the entities a GraphLink can name. */
export type GraphEntityKind = "album" | "artist" | "galaxy" | "label";

/** What a hover card (and the SSH/CLI surfaces, later) needs to preview an entity. */
export type GraphPreview = {
  /** Up to a handful of finding covers — the card's visual proof. */
  covers: string[];
  /** FINDINGS only (never the unlit catalogue rows). */
  findingCount: number;
  kind: GraphEntityKind;
  /**
   * The entity page's OWN opening line. Not a summary of it — it. Undefined when the entity
   * carries no finding: the page prints no line there, so the card prints none either (it
   * never invents a sentence, and it never apologises for what is not on the page).
   */
  line: string | undefined;
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
): string | undefined {
  if (findingCount === 0) {
    return undefined;
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

/** The label page's opening line — Fluncle's relationship to the label. */
export function labelSignatureLine(
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string | undefined {
  if (findingCount === 0) {
    return undefined;
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "One finding on this label so far. Play it loud."
      : `${findingsCount(findingCount)} on this label so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I pulled my first tune off ${name} on ${when}. Just the one so far. Play it loud.`;
  }

  return `I pulled my first tune off ${name} on ${when}, and I'm up to ${findingsCount(findingCount)} on this label now. Have a dig.`;
}

/** The album page's opening line — Fluncle's relationship to the record. */
export function albumSignatureLine(
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string | undefined {
  if (findingCount === 0) {
    return undefined;
  }

  if (!firstFoundAt) {
    return findingCount === 1
      ? "One finding on this record so far. Play it loud."
      : `${findingsCount(findingCount)} on this record so far. Have a dig.`;
  }

  const when = formatDateLong(firstFoundAt);

  if (findingCount === 1) {
    return `I pulled my first tune off ${name} on ${when}. Just the one so far. Play it loud.`;
  }

  return `I pulled my first tune off ${name} on ${when}, and I'm up to ${findingsCount(findingCount)} off this record now. Have a dig.`;
}

/**
 * The galaxy lens page's opening line (the Garnish Rule — a real relation with cosmos trim,
 * never a genre claim): what the region IS, said not written, no k-means jargon.
 *
 * A galaxy is minted from its members, so an empty one is unreachable — but it returns nothing
 * for zero all the same, so every builder here obeys the one rule and no caller has to special-
 * case a fourth kind.
 */
export function galaxyIntroLine(findingCount: number): string | undefined {
  if (findingCount === 0) {
    return undefined;
  }

  if (findingCount === 1) {
    return "One finding out here so far, and everything near it in sound.";
  }

  return `${findingsCount(findingCount)} that hit the same way, core of the galaxy first.`;
}

/**
 * The one opening line for any entity, dispatched by kind. The GraphLink hover card reads
 * THIS; each entity page reads its own builder above directly (it already holds the richer
 * inputs). Same functions either way — the card can never drift from the page.
 *
 * `undefined` when the entity carries no finding: the card prints no line, exactly as the page
 * prints no line. The card's rule is that it never invents a sentence, and "no sentence" is the
 * honest answer here — not a filler one.
 */
export function graphSignatureLine(
  kind: GraphEntityKind,
  name: string,
  findingCount: number,
  firstFoundAt: string | undefined,
): string | undefined {
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
