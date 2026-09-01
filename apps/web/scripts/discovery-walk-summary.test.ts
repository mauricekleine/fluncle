import { describe, expect, it } from "vitest";

import { beaconEvents, renderWalkSummary, type WalkIndex } from "./discovery-walk-summary";

const step = (over: Partial<WalkIndex["journeys"][string][number]>) => ({
  beacons: [],
  canonical: null,
  errors: [],
  outbound: null,
  robots: null,
  screenshot: "shot.png",
  status: 200,
  step: "front door",
  title: "Fluncle",
  url: "https://www.fluncle.com/",
  ...over,
});

describe("beaconEvents", () => {
  it("keeps only the bounded event names off a beacon URL, never the rest of it", () => {
    expect(
      beaconEvents([
        "https://queue.simpleanalyticscdn.com/simple.gif?hostname=x&type=pageview",
        "https://queue.simpleanalyticscdn.com/simple.gif?type=event&event=discovery_open&metadata=%7B%22kind%22%3A%22finding%22%7D",
        "https://scripts.simpleanalyticscdn.com/latest.js",
      ]),
    ).toEqual(["discovery_open"]);
  });
});

describe("renderWalkSummary", () => {
  const index: WalkIndex = {
    base: "https://www.fluncle.com",
    journeys: {
      "1-zero-input-browse": [
        step({}),
        step({
          beacons: ["https://queue.simpleanalyticscdn.com/simple.gif?event=discovery_outbound"],
          outbound:
            "https://open.spotify.com/track/abc → popup: https://open.spotify.com/track/abc",
          screenshot: "desktop--01-listen.png",
          status: null,
          step: "listen outbound",
          url: "https://www.fluncle.com/log/090.6.2K",
        }),
      ],
      "3-entity-landing": [
        step({
          errors: ["console.error: boom"],
          robots: "noindex, follow",
          step: "thin | track",
          url: "https://www.fluncle.com/track/mb_x",
        }),
      ],
    },
    served: "29eb1984b21864ef71e2b11a9855e895e819fc18",
    viewport: { height: 900, name: "desktop-1440x900", width: 1440 },
  };

  it("names the served commit, one table per journey, one row per step, destinations relative", () => {
    const markdown = renderWalkSummary([index]);

    expect(markdown).toContain(
      "Walked https://www.fluncle.com serving commit 29eb1984b21864ef71e2b11a9855e895e819fc18.",
    );
    expect(markdown).toContain("## desktop-1440x900 (1440×900) — 1 console/page error(s)");
    expect(markdown).toContain("### 1-zero-input-browse");
    expect(markdown).toContain("| front door | / | 200 | index | — | — | shot.png |");
    expect(markdown).toContain(
      "| listen outbound | /log/090.6.2K | — | index | https://open.spotify.com/track/abc → popup: https://open.spotify.com/track/abc | discovery_outbound | desktop--01-listen.png |",
    );
    // A pipe inside a cell is escaped so the table survives; a noindex directive is shown as is.
    expect(markdown).toContain("| thin \\| track | /track/mb_x | 200 | noindex, follow |");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("says so when the served commit is unknown rather than inventing one", () => {
    expect(renderWalkSummary([{ ...index, served: null }])).toContain("serving commit unknown.");
  });
});
