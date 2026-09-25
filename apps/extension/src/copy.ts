export function findingsLabel(count: number): string {
  return count === 1 ? "1 finding" : `${count} findings`;
}

export function bangersLabel(count: number): string {
  return count === 1 ? "1 banger" : `${count} bangers`;
}

export const COPY = {
  actions: {
    copyCoordinate: "Copy coordinate",
    copyDig: "Copy dig command",
    copySsh: "Copy ssh command",
    copyWebUrl: "Copy web URL",
    open: "Open in Fluncle",
    openSpotify: "Open in Spotify",
  },

  copied: "Copied",

  countHeading(count: number): string {
    if (count === 0) {
      return "Nothing found here";
    }

    return `${findingsLabel(count)} on this page`;
  },

  description: "Fluncle Lens surfaces the findings hidden across the web.",

  emptyState: "No findings on this page.",

  metaError: "The details didn't survive the trip. The link still lands.",

  metaLoading: "Recovering this finding…",

  name: "Fluncle Lens",

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

  tagline: "Findings hidden across the web.",
} as const;
