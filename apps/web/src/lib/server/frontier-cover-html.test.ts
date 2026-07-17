import { describe, expect, it } from "vitest";
import {
  buildFrontierCoverHtml,
  FRONTIER_COVER_MAX_JPEG_BYTES,
  FRONTIER_COVER_PX,
  frontierCrewStamp,
} from "./frontier-cover-html";

// Pins the Satori TWIN of the Remotion Frontier-cover master (frontier-cover.tsx) WITHOUT a
// raster — the satori-render.test.ts discipline: the composition is a pure HTML string, so the
// tree/text/marks are assertable directly. What only the WASM raster + Cloudflare Images could
// prove (the pixels, the JPEG bytes) is out of scope here; what IS pinned is the layout the raster
// is fed, which is where a drift from the master would silently ship a wrong cover.

describe("frontierCrewStamp", () => {
  it("zero-pads to three digits with the '#' stand-in (# not № — outside the font cut)", () => {
    expect(frontierCrewStamp(42)).toBe("# 042");
    expect(frontierCrewStamp(7)).toBe("# 007");
    expect(frontierCrewStamp(1254)).toBe("# 1254");
  });

  it("is null for a legacy account (no crew number) — no chip is drawn", () => {
    expect(frontierCrewStamp(null)).toBeNull();
    expect(frontierCrewStamp(undefined)).toBeNull();
    expect(frontierCrewStamp(0)).toBeNull();
  });
});

describe("buildFrontierCoverHtml", () => {
  it("stacks FLUNCLE'S / FRONTIER in the Oxanium 800 brand cut over the founding image", () => {
    const html = buildFrontierCoverHtml({ crewNumber: 42 });

    // The founding artifact, inlined as a bundled data-URI (Satori does not fetch remote <img>).
    expect(html).toContain("data:image/");
    // The brand plate — the real right-single-quote (U+2019), which IS in the font cut; an HTML
    // entity would render literally (workers-og does not decode on the way in).
    expect(html).toContain("FLUNCLE’S");
    expect(html).toContain("FRONTIER");
    // Brand face + display weight.
    expect(html).toContain("Oxanium");
    expect(html).toContain("font-weight:800");
    // The square is sized for Spotify's thumbnail.
    expect(html).toContain(`width:${FRONTIER_COVER_PX}px`);
    expect(html).toContain(`height:${FRONTIER_COVER_PX}px`);
    // The Legible-Sky scrim band.
    expect(html).toContain("linear-gradient(180deg");
  });

  it("stamps the crew chip bottom-left when the owner has a crew number", () => {
    const html = buildFrontierCoverHtml({ crewNumber: 42 });

    expect(html).toContain("# 042");
    // The printed chip — Tape-Black fill, Dust-Line border, bottom-left.
    expect(html).toContain("border-radius:10px");
    expect(html).toContain("bottom:30px");
    expect(html).toContain("left:30px");
  });

  it("draws NO chip for a legacy account (null crew number)", () => {
    const html = buildFrontierCoverHtml({ crewNumber: null });

    // No stamp text, and none of the chip's box.
    expect(html).not.toContain("# ");
    expect(html).not.toContain("border-radius:10px");
    // The brand plate still renders — the cover is never blank.
    expect(html).toContain("FRONTIER");
  });
});

describe("the Spotify byte ceiling", () => {
  it("is 192KB — the ~256KB base64 cap in JPEG bytes", () => {
    expect(FRONTIER_COVER_MAX_JPEG_BYTES).toBe(192 * 1024);
  });
});
