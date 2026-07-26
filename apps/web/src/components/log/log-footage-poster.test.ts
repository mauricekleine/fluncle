import { describe, expect, it } from "vitest";
import { firstPaintFootagePoster } from "./log-footage";

// The /log page's LCP element is the footage pane's POSTER, not the clip: the clip holds
// `preload="none"` until it is near the viewport, so the poster is the only thing the pane paints
// first. `firstPaintFootagePoster` is that URL, lifted out so the ROUTE can preload it from `head()`
// instead of leaving the browser to find it on a `<video poster>` attribute ~46 KB into the body.
//
// The contract these pin is the one that makes the preload a HEAD START rather than a second
// request: it must reproduce the component's unmeasured first-paint branch byte for byte —
// portrait crop (the orientation `useMediaQuery` reports until mounted, so also what SSR emits), the
// 480 rung (one below the portrait pane's 720 ceiling; a still needs less than the clip), zero stall
// downshifts. If the component's derivation moves and this does not, the preload silently doubles
// the fetch instead of removing a wait — hence a test, not a comment.

const track = (over: Record<string, unknown> = {}) =>
  ({
    albumImageUrl: "https://i.scdn.co/image/ab67616d00001e02cafef00d",
    logId: "001.1.1A",
    videoSquaredAt: null,
    videoUrl: "https://found.fluncle.com/001.1.1A/footage.mp4",
    ...over,
  }) as never;

describe("firstPaintFootagePoster", () => {
  it("crops a two-master finding's poster to the PORTRAIT pane at the 480 rung", () => {
    const url = firstPaintFootagePoster(track({ videoSquaredAt: "2026-07-13T00:00:00.000Z" }));

    expect(url).toBeDefined();
    // A 9:16 crop off the 1920² square master: 480 wide ⇒ 853 tall (480 × 16/9, rounded).
    expect(url).toContain("width=480");
    expect(url).toContain("height=853");
    expect(url).toContain("mode=frame");
    // The video vintage rides the SOURCE as its bust, so a re-render re-keys the rendition.
    expect(url).toContain(`?v=${Date.parse("2026-07-13T00:00:00.000Z")}`);
  });

  it("takes a plain opening frame off a legacy portrait master (no crop to derive)", () => {
    const url = firstPaintFootagePoster(track());

    expect(url).toContain("mode=frame");
    expect(url).toContain("/001.1.1A/footage.mp4");
    expect(url).not.toContain("width=");
  });

  it("is undefined without footage — a preload has to be a certainty, not a guess", () => {
    // No clip means the pane falls through a frame transform that cannot exist, to the bundle
    // poster, to the album cover. Which of the three paints is not knowable from the route, so the
    // route spends no preload and the pane's own <img> carries the priority signal instead.
    expect(firstPaintFootagePoster(track({ videoUrl: undefined }))).toBeUndefined();
    expect(firstPaintFootagePoster(track({ logId: undefined }))).toBeUndefined();
  });
});
