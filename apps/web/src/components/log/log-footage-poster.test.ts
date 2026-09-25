import { describe, expect, it } from "vitest";
import { firstPaintFootagePoster } from "./log-footage";

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

    expect(url).toContain("width=480");
    expect(url).toContain("height=853");
    expect(url).toContain("mode=frame");

    expect(url).toContain(`?v=${Date.parse("2026-07-13T00:00:00.000Z")}`);
  });

  it("takes a plain opening frame off a legacy portrait master (no crop to derive)", () => {
    const url = firstPaintFootagePoster(track());

    expect(url).toContain("mode=frame");
    expect(url).toContain("/001.1.1A/footage.mp4");
    expect(url).not.toContain("width=");
  });

  it("is undefined without footage — a preload has to be a certainty, not a guess", () => {
    expect(firstPaintFootagePoster(track({ videoUrl: undefined }))).toBeUndefined();
    expect(firstPaintFootagePoster(track({ logId: undefined }))).toBeUndefined();
  });
});
