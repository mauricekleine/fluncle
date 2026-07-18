// THE GRAPH ENTITIES' OPENING LINES — written once, read twice; three of four RETIRED.
//
// Fluncle's archive is a graph: log ↔ artist ↔ label ↔ album ↔ galaxy. The GALAXY page opens
// with one first-person intro line (a galaxy is lore); the artist/label/album pages open with
// NO line at all — their first-person signature lines ("I'm up to 3 findings on this label
// now") were retired by the Three Areas Rule (DESIGN.md; VOICE.md §5, ratified 2026-07-18):
// those are CATALOGUE pages, reference shelves where Fluncle appears as data and through the
// third-person dossier bio, never as narrator.
//
// The one surviving line has TWO readers: the galaxy page masthead and the GraphLink hover
// card. They MUST be the same sentence, so the builder lives here, pure, and both callers
// import it. The dispatch below returns `undefined` for the three catalogue kinds — the card
// mirrors the page BY CONSTRUCTION either way (for catalogue entities it shows the dossier
// bio the page shows).
//
// VOICE.md, for the SURVIVING GALAXY LINE only: first person, said-not-written, active —
// never a fabricated bio, never a claim about the music he has not made. The counts
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

import { findingsCount } from "./format";

/** The four non-log nodes of the graph — the entities a GraphLink can name. */
export type GraphEntityKind = "album" | "artist" | "galaxy" | "label";

/** What a hover card (and the SSH/CLI surfaces, later) needs to preview an entity. */
export type GraphPreview = {
  /**
   * The entity's factual, third-person bio (artist/label/album), when one is authored — the SAME
   * paragraph the entity page prints beneath its dateline. Undefined when none exists yet (the
   * backfill is in flight for many entities) and for galaxy previews, which never carry one. The
   * card renders it below the signature `line`, clamped; absent, the card is unchanged.
   */
  bio?: string;
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
  _firstFoundAt: string | undefined,
): string | undefined {
  switch (kind) {
    case "galaxy": {
      return galaxyIntroLine(findingCount);
    }
    default: {
      // Artist, label, album: catalogue kinds carry no signature line (the Three Areas Rule) —
      // the page masthead prints none, so the card prints none, by the same dispatch.
      return undefined;
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
