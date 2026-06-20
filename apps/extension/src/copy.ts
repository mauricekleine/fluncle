// Every human-facing string in Fluncle Lens, in one place so the voice stays
// consistent and reviewable. This is a Fluncle surface (web register: warm, quiet,
// in-fiction, sentence case, no exclamation marks).
//
// Voice note on "signals": the brief leans on "signals detected" language, but the
// Voice canon (VOICE.md) bans "signal(s)" — it's the retired radio metaphor, the
// same one that killed "transmission". Fluncle finds and logs; he doesn't pick up
// signals. So the lens speaks in the canon's own family instead: a `fluncle://`
// coordinate on a page IS a finding (its Log ID), and the lens FINDS them. "found"
// is the verb, "finding(s)" the unit.

/** Pluralizes "finding" for a count. */
export function findingsLabel(count: number): string {
  return count === 1 ? "1 finding" : `${count} findings`;
}

/** Pluralizes "banger" for a mixtape's member count (the set's tracklist length). */
export function bangersLabel(count: number): string {
  return count === 1 ? "1 banger" : `${count} bangers`;
}

export const COPY = {
  /** Hover-card and popup row actions (functional labels — literal, no garnish). */
  actions: {
    copyCoordinate: "Copy coordinate",
    copyDig: "Copy dig command",
    copySsh: "Copy ssh command",
    copyWebUrl: "Copy web URL",
    open: "Open in Fluncle",
    openSpotify: "Open in Spotify",
  },

  /** Transient confirmation after a copy action. */
  copied: "Copied",

  /** The popup header line — turns to the crew once a count exists. */
  countHeading(count: number): string {
    if (count === 0) {
      return "Nothing found here";
    }

    return `${findingsLabel(count)} on this page`;
  },

  /** The extension's one-line description (manifest + store). */
  description: "Fluncle Lens surfaces the findings hidden across the web.",

  /** Popup empty state — quiet, in-fiction, matches the web empty state. */
  emptyState: "No findings on this page. Quiet sector.",

  /**
   * Hover card / popup state when the coordinate resolved (the link works) but the
   * enrichment read didn't come back. Not a failure — a finding that arrived lossy
   * (the Light-Years Rule). Harmonizes with the "Recovering…" loading register.
   */
  metaError: "The details didn't survive the trip. The link still lands.",

  /** Hover card / popup while the metadata read is in flight. */
  metaLoading: "Recovering this finding…",

  name: "Fluncle Lens",

  /** Options screen. */
  options: {
    linkTargetHint: "Where a coordinate points when you open it.",
    linkTargetLabel: "Open findings on",
    linkTargetWeb: "fluncle.com",
    scanHint:
      "Read every page locally for hidden coordinates. Nothing about the page leaves your browser.",
    scanLabel: "Scan all websites",
    showCardsHint: "Show a finding's details when you hover its coordinate.",
    showCardsLabel: "Show hover cards",
    title: "Fluncle Lens",
  },

  /** Popup subtitle under the name. */
  tagline: "Findings hidden across the web.",
} as const;
