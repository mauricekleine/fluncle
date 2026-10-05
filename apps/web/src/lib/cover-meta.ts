import { siteUrl } from "./fluncle-links";

export const fluncleCoverUrl = `${siteUrl}/fluncle-cover.png`;

export const fluncleCoverImageMeta: Array<{ content: string; property: string }> = [
  { content: fluncleCoverUrl, property: "og:image" },
  { content: "1254", property: "og:image:width" },
  { content: "1254", property: "og:image:height" },
  {
    content:
      "Cover of Fluncle's Findings: an astronaut drifts over tower blocks at night under a burning eclipse, tethered to a CD player.",
    property: "og:image:alt",
  },
];
