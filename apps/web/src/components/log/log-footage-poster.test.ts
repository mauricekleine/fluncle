import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Track } from "@/lib/tracks";
import { firstPaintFootagePoster, LogFootage } from "./log-footage";

const track = (over: Partial<Track> = {}): Track => ({
  addedAt: "2026-07-13T00:00:00.000Z",
  addedToSpotify: true,
  albumImageUrl: "https://i.scdn.co/image/ab67616d00001e02cafef00d",
  artists: ["Artist"],
  durationMs: 180_000,
  enrichmentStatus: "done",
  logId: "001.1.1A",
  postedToTelegram: true,
  spotifyUrl: "https://open.spotify.com/track/fixture",
  title: "Finding",
  trackId: "track-1",
  videoSquaredAt: undefined,
  videoUrl: "https://found.fluncle.com/001.1.1A/footage.mp4",
  ...over,
});

describe("firstPaintFootagePoster", () => {
  it("preloads the stored poster at the portrait pane's 480 rung", () => {
    const url = firstPaintFootagePoster(track({ videoSquaredAt: "2026-07-13T00:00:00.000Z" }));

    expect(url).toBe(
      `https://found.fluncle.com/cdn-cgi/image/fit=cover,width=480,height=854,format=auto/https://found.fluncle.com/001.1.1A/poster.jpg?v=${Date.parse("2026-07-13T00:00:00.000Z")}`,
    );
  });

  it("preserves the stored aspect for legacy footage", () => {
    const url = firstPaintFootagePoster(track());

    expect(url).toBe(
      "https://found.fluncle.com/cdn-cgi/image/width=480,format=auto/https://found.fluncle.com/001.1.1A/poster.jpg?v=1",
    );
  });

  it.each([undefined, "2026-07-13T00:00:00.000Z"])(
    "renders the exact preloaded URL before the pane is measured (%s)",
    (videoSquaredAt) => {
      const finding = track({ videoSquaredAt });
      const html = renderToStaticMarkup(createElement(LogFootage, { track: finding }));

      expect(html).toContain(`poster="${firstPaintFootagePoster(finding)}"`);
    },
  );

  it("renders a transformed stored poster as an image without master footage", () => {
    const html = renderToStaticMarkup(
      createElement(LogFootage, { track: track({ videoUrl: undefined }) }),
    );

    expect(html).toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).toContain(
      'src="https://found.fluncle.com/cdn-cgi/image/width=480,format=auto/https://found.fluncle.com/001.1.1A/poster.jpg?v=1"',
    );
  });

  it("is undefined without footage — a preload has to be a certainty, not a guess", () => {
    expect(firstPaintFootagePoster(track({ videoUrl: undefined }))).toBeUndefined();
    expect(firstPaintFootagePoster(track({ logId: undefined }))).toBeUndefined();
  });
});
