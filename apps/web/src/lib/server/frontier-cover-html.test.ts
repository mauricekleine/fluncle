import { describe, expect, it } from "vitest";
import {
  buildFrontierCoverHtml,
  FRONTIER_COVER_MAX_JPEG_BYTES,
  FRONTIER_COVER_PX,
  frontierCrewStamp,
} from "./frontier-cover-html";

describe("frontierCrewStamp", () => {
  it("zero-pads to three digits with the all-Oxanium 'Nº' numero (Oxanium has no № glyph)", () => {
    expect(frontierCrewStamp(42)).toBe("Nº 042");
    expect(frontierCrewStamp(7)).toBe("Nº 007");
    expect(frontierCrewStamp(1254)).toBe("Nº 1254");
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

    expect(html).toContain("data:image/");

    expect(html).toContain("FLUNCLE’S");
    expect(html).toContain("FRONTIER");

    expect(html).toContain("Oxanium");
    expect(html).toContain("font-weight:800");

    expect(html).toContain(`width:${FRONTIER_COVER_PX}px`);
    expect(html).toContain(`height:${FRONTIER_COVER_PX}px`);

    expect(html).toContain("linear-gradient(180deg");
  });

  it("stamps the crew chip bottom-left when the owner has a crew number", () => {
    const html = buildFrontierCoverHtml({ crewNumber: 42 });

    expect(html).toContain("Nº 042");

    expect(html).toContain("border-radius:10px");
    expect(html).toContain("bottom:30px");
    expect(html).toContain("left:30px");
  });

  it("draws NO chip for a legacy account (null crew number)", () => {
    const html = buildFrontierCoverHtml({ crewNumber: null });

    expect(html).not.toContain("Nº");
    expect(html).not.toContain("border-radius:10px");

    expect(html).toContain("FRONTIER");
  });
});

describe("the Spotify byte ceiling", () => {
  it("is 192KB — the ~256KB base64 cap in JPEG bytes", () => {
    expect(FRONTIER_COVER_MAX_JPEG_BYTES).toBe(192 * 1024);
  });
});
