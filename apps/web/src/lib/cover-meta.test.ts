import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fluncleCoverImageMeta } from "./cover-meta";

const coverPath = join(dirname(fileURLToPath(import.meta.url)), "../../public/fluncle-cover.png");

function pngSize(path: string): { height: number; width: number } {
  const header = readFileSync(path);

  return { height: header.readUInt32BE(20), width: header.readUInt32BE(16) };
}

function content(property: string): string | undefined {
  return fluncleCoverImageMeta.find((entry) => entry.property === property)?.content;
}

describe("fluncleCoverImageMeta", () => {
  it("leads with og:image so every structured property describes it", () => {
    expect(fluncleCoverImageMeta[0]?.property).toBe("og:image");
    expect(
      fluncleCoverImageMeta.slice(1).every((entry) => entry.property.startsWith("og:image:")),
    ).toBe(true);
  });

  it("declares the real cover dimensions", () => {
    const { height, width } = pngSize(coverPath);

    expect(content("og:image:width")).toBe(String(width));
    expect(content("og:image:height")).toBe(String(height));
  });

  it("describes the cover in alt text", () => {
    expect(content("og:image:alt")).toBeTruthy();
  });
});
