import { describe, expect, test } from "bun:test";
import { compareVersions, normalizeVersion } from "./version";

// The two pure halves of the update notifier's decision (update-notifier.ts:52 gates the
// upgrade notice on `compareVersions(latest, current) > 0`, after `normalizeVersion` strips
// the GitHub tag's `v`). Getting either wrong is silent in both directions: a nag on every
// command, or a CLI that never tells the operator a newer build exists.

describe("normalizeVersion", () => {
  test("strips the release tag's leading v, either case", () => {
    expect(normalizeVersion("v1.4.2")).toBe("1.4.2");
    expect(normalizeVersion("V1.4.2")).toBe("1.4.2");
  });

  test("trims surrounding whitespace before stripping", () => {
    expect(normalizeVersion("  v1.4.2\n")).toBe("1.4.2");
  });

  test("leaves an already-bare version alone", () => {
    expect(normalizeVersion("1.4.2")).toBe("1.4.2");
  });

  test("passes undefined through — a missing tag is not a version", () => {
    expect(normalizeVersion(undefined)).toBeUndefined();
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.4.3", "1.4.2")).toBeGreaterThan(0);
  });

  test("compares each segment numerically, not as a string", () => {
    // "10" < "9" lexically; the notifier must not miss the 1.9.0 → 1.10.0 bump.
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });

  test("reports equality as zero — the notifier stays silent on the current build", () => {
    expect(compareVersions("1.4.2", "1.4.2")).toBe(0);
  });

  test("treats a missing segment as zero, so a short version still compares", () => {
    expect(compareVersions("1.4", "1.4.0")).toBe(0);
    expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
  });

  test("reads a segment's leading digits, so a prerelease tag is not an upgrade", () => {
    // `1.4.2-beta` parses as 1.4.2 and compares EQUAL to the release — the notifier
    // stays quiet rather than nagging an operator already on the same build.
    expect(compareVersions("1.4.2-beta", "1.4.2")).toBe(0);
    expect(compareVersions("1.5.0-rc.1", "1.4.2")).toBeGreaterThan(0);
  });

  test("degrades a wholly unparseable segment to zero rather than NaN", () => {
    // A NaN difference is never `!== 0`, so every segment would compare equal and a
    // garbage tag would silently read as "no upgrade" for the wrong reason.
    expect(compareVersions("nonsense", "0.0.0")).toBe(0);
    expect(compareVersions("nonsense", "0.1.0")).toBeLessThan(0);
  });
});
