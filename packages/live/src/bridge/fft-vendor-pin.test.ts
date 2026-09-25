import { describe, expect, test } from "bun:test";

const VENDORED_URL = new URL("./fft.ts", import.meta.url);
const ORIGINAL_URL = new URL("../../../video/src/pipeline/fft.ts", import.meta.url);

function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/\/\/[^\n]*/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("bridge/fft.ts is a faithful vendoring of packages/video/src/pipeline/fft.ts", () => {
  test("both files exist and carry real code (the comparison is not vacuous)", async () => {
    const vendored = codeOnly(await Bun.file(VENDORED_URL).text());
    const original = codeOnly(await Bun.file(ORIGINAL_URL).text());

    expect(vendored.length).toBeGreaterThan(500);
    expect(original.length).toBeGreaterThan(500);
    expect(vendored).toContain("export function fftInPlace");
  });

  test("the executable text is identical, comments aside", async () => {
    const vendored = codeOnly(await Bun.file(VENDORED_URL).text());
    const original = codeOnly(await Bun.file(ORIGINAL_URL).text());

    expect(
      vendored,
      "bridge/fft.ts has drifted from packages/video/src/pipeline/fft.ts — mirror the change (the two fingerprint the SAME audio from opposite ends of the live matcher)",
    ).toBe(original);
  });
});
