import { describe, expect, test } from "bun:test";

// THE VENDORED COPY, PINNED TO ITS ORIGINAL.
//
// ./fft.ts is a deliberate byte-for-byte vendoring of packages/video/src/pipeline/fft.ts —
// vendored rather than imported because the bridge is local-only and self-contained by the
// live RFC's failure-matrix floor. Its own header carries the maintenance instruction: "If the
// render path's copy changes, mirror it here."
//
// Nothing enforced that. The two copies feed the SAME identity decision from two directions —
// the render path fingerprints a finding's audio offline, the bridge fingerprints the deck's
// audio live, and a match is what puts a scene on the glass — so a fix landing in one copy and
// not the other does not fail a build or a test. It silently makes the live matcher measure a
// slightly different spectrum than the archive it is matching against, and the failure surfaces
// as "the wrong scene during a set", the one thing the never-show-the-wrong-finding rail exists
// to prevent.
//
// So: the CODE of the two files must be identical. Comments are excluded from the comparison
// because the divergence is documented and intended — the vendored header explains the
// vendoring, and the `fftInPlace` doc-comment drops the render path's N=2048 rounding aside.
// Any difference in an actual statement fails here, naming the mirror as the fix.

const VENDORED_URL = new URL("./fft.ts", import.meta.url);
const ORIGINAL_URL = new URL("../../../video/src/pipeline/fft.ts", import.meta.url);

/**
 * A TS source reduced to its executable text: block comments and line comments removed, all
 * whitespace collapsed. Sound for these two files specifically — neither contains a string
 * literal, template literal, or regex literal, so no `//` or `/*` can appear inside one.
 */
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

  test("the vendored header still says it is vendored, and from where", async () => {
    const header = await Bun.file(VENDORED_URL).text();

    expect(header).toContain("packages/video/src/pipeline/fft.ts");
    expect(header).toContain("mirror it here");
  });
});
