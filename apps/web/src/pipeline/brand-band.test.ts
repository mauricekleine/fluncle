import { describe, expect, it } from "vitest";
import { fillFor, inVioletBand } from "./create-pipeline";
import { LOGOS } from "./logos";

function channels(fill: string): [number, number, number] {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(fill);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  const hex = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(fill);
  if (hex) {
    return [parseInt(hex[1] ?? "", 16), parseInt(hex[2] ?? "", 16), parseInt(hex[3] ?? "", 16)];
  }
  throw new Error(`unparsed fill: ${fill}`);
}

describe("/pipeline brand-mark fills", () => {
  it("names the band by its channel order: Nebula Violet in, its neighbours out", () => {
    expect(inVioletBand(0xab, 0x7b, 0xff)).toBe(true);
    expect(inVioletBand(0x58, 0x65, 0xf2)).toBe(false);
    expect(inVioletBand(0xff, 0x00, 0x69)).toBe(false);
  });

  it.each(Object.entries(LOGOS))(
    "renders %s outside Nebula Violet's reserved band",
    (_slug, logo) => {
      const fill = fillFor(logo.hex);
      if (fill === "currentColor") {
        return;
      }
      const [r, g, b] = channels(fill);
      expect(inVioletBand(r, g, b)).toBe(false);
    },
  );

  it("drops an in-band brand colour to the chip's ink", () => {
    expect(fillFor("#9146FF")).toBe("currentColor");
  });
});
