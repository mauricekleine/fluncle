// Unit tests for the pure CAPTURE-VERIFICATION matcher (fingerprint-match.ts). The box script
// is self-contained (it can't import the workspace) and lives outside any package's runner, so
// this uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/fingerprint-match.test.ts
//
// CI has NO fpcalc binary, so the pure matcher takes fingerprint ARRAYS (never a path) and the
// subprocess/fetch helpers are exercised only through their PARSE seams (`parseFpcalcJson`,
// `parseRejectedSources`). Keep this green when touching the sliding-window match, the threshold,
// or the rejection-memory helpers.
import { describe, expect, test } from "bun:test";
import {
  appendRejectedSource,
  DEFAULT_MAX_BER,
  MIN_OVERLAP_FRAMES,
  parseFpcalcJson,
  parseRejectedSources,
  popcount32,
  REJECTED_MEMORY_CAP,
  rejectedShas,
  rejectedVideoIds,
  slidingWindowMatch,
} from "./fingerprint-match";

describe("popcount32", () => {
  test("counts set bits in a 32-bit int", () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0b1011)).toBe(3);
    expect(popcount32(0xffffffff | 0)).toBe(32);
    expect(popcount32(0x80000000 | 0)).toBe(1);
  });
});

// A deterministic pseudo-random uint32 stream — a stand-in for a real fpcalc fingerprint.
function randomFingerprint(length: number, seed: number): number[] {
  const out: number[] = [];
  let state = seed >>> 0;

  for (let i = 0; i < length; i += 1) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out.push(state | 0);
  }

  return out;
}

// Flip `bitsPerFrame` random bits in each frame — models cross-source encoding noise on a true
// match (BER ≈ bitsPerFrame / 32).
function addNoise(fp: readonly number[], bitsPerFrame: number, seed: number): number[] {
  let state = seed >>> 0;
  const nextBit = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return (state >>> 0) % 32;
  };

  return fp.map((frame) => {
    let out = frame | 0;
    const flipped = new Set<number>();

    while (flipped.size < bitsPerFrame) {
      const bit = nextBit();

      if (!flipped.has(bit)) {
        flipped.add(bit);
        out ^= 1 << bit;
      }
    }

    return out;
  });
}

describe("slidingWindowMatch", () => {
  test("a CONTAINED match: the preview appears verbatim inside the capture → BER 0, match", () => {
    const capture = randomFingerprint(2000, 42);
    // A 240-frame excerpt taken from the middle of the capture — a verbatim preview.
    const preview = capture.slice(800, 1040);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result).not.toBeNull();
    expect(result?.ber).toBe(0);
    expect(result?.match).toBe(true);
    expect(result?.overlap).toBe(240);
  });

  test("an OFFSET match at a different position still finds the alignment", () => {
    const capture = randomFingerprint(2400, 7);
    // The excerpt starts near the END — the min must scan every offset to find it.
    const preview = capture.slice(2100, 2340);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result?.ber).toBe(0);
    expect(result?.match).toBe(true);
  });

  test("a NON-match: an unrelated capture sits near the ~0.5 random regime → no match", () => {
    const preview = randomFingerprint(240, 1);
    const capture = randomFingerprint(2000, 999);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result).not.toBeNull();
    // Two unrelated uint32 streams XOR to ~half the bits set. Comfortably above the 0.20 line.
    expect(result?.ber).toBeGreaterThan(0.4);
    expect(result?.match).toBe(false);
  });

  test("a cross-source match with encoding noise still lands under the threshold", () => {
    const capture = randomFingerprint(2000, 314);
    // A true excerpt, but every frame carries ~4 flipped bits (BER ≈ 4/32 = 0.125) — the
    // different-codec case the 0.20 threshold is widened for.
    const preview = addNoise(capture.slice(600, 840), 4, 55);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result?.ber).toBeGreaterThan(0);
    expect(result?.ber).toBeLessThan(DEFAULT_MAX_BER);
    expect(result?.match).toBe(true);
  });

  test("THE THRESHOLD BOUNDARY: match is `ber <= threshold`, inclusive", () => {
    // Two 40-frame fingerprints differing by EXACTLY one bit per frame → BER = 1/32 = 0.03125.
    const base = randomFingerprint(40, 3);
    const noisy = addNoise(base, 1, 9);

    // A threshold set exactly at the BER matches (inclusive); a hair below does not.
    expect(slidingWindowMatch(noisy, base, 1 / 32)?.match).toBe(true);
    expect(slidingWindowMatch(noisy, base, 1 / 32 - 1e-9)?.match).toBe(false);
  });

  test("INCONCLUSIVE below the minimum overlap → null (abstain, never a spurious match)", () => {
    const tiny = randomFingerprint(MIN_OVERLAP_FRAMES - 1, 5);
    const capture = randomFingerprint(2000, 6);

    expect(slidingWindowMatch(tiny, capture, DEFAULT_MAX_BER)).toBeNull();
    expect(slidingWindowMatch([], capture, DEFAULT_MAX_BER)).toBeNull();
  });

  test("is symmetric in argument order (shorter always slid over longer)", () => {
    const capture = randomFingerprint(2000, 11);
    const preview = capture.slice(500, 740);

    const a = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);
    const b = slidingWindowMatch(capture, preview, DEFAULT_MAX_BER);

    expect(a?.ber).toBe(b?.ber);
    expect(a?.match).toBe(b?.match);
  });
});

describe("parseFpcalcJson", () => {
  test("parses fpcalc -raw -json into the integer array", () => {
    expect(parseFpcalcJson('{"duration":29.98,"fingerprint":[1,2,3,-4]}')).toEqual([1, 2, 3, -4]);
  });

  test("returns null on junk, an empty fingerprint, or a non-numeric entry", () => {
    expect(parseFpcalcJson("not json")).toBeNull();
    expect(parseFpcalcJson('{"fingerprint":[]}')).toBeNull();
    expect(parseFpcalcJson('{"fingerprint":["x"]}')).toBeNull();
    expect(parseFpcalcJson("{}")).toBeNull();
  });
});

describe("the bad-audio memory (appendRejectedSource / parse / sets)", () => {
  const at = "2026-07-13T00:00:00.000Z";

  test("appends and caps at the newest REJECTED_MEMORY_CAP (oldest dropped)", () => {
    let memory: ReturnType<typeof appendRejectedSource> = [];

    for (let i = 0; i < REJECTED_MEMORY_CAP + 5; i += 1) {
      memory = appendRejectedSource(memory, {
        at,
        reason: "test",
        sha256: `sha${i}`,
        videoId: `v${i}`,
      });
    }

    expect(memory).toHaveLength(REJECTED_MEMORY_CAP);
    // The oldest five are gone; the newest survives.
    expect(memory[0]?.sha256).toBe("sha5");
    expect(memory.at(-1)?.sha256).toBe(`sha${REJECTED_MEMORY_CAP + 4}`);
  });

  test("dedupes on (videoId, sha256) so a re-flag does not evict good entries", () => {
    const one = appendRejectedSource(null, { at, reason: "a", sha256: "s1", videoId: "v1" });
    const two = appendRejectedSource(one, { at, reason: "b", sha256: "s1", videoId: "v1" });

    expect(two).toHaveLength(1);
    expect(two[0]?.reason).toBe("b");
  });

  test("parseRejectedSources tolerates a JSON string, an array, and junk", () => {
    const json = JSON.stringify([{ at, reason: "x", sha256: "s1", videoId: "v1" }, { bad: true }]);

    expect(parseRejectedSources(json)).toEqual([{ at, reason: "x", sha256: "s1", videoId: "v1" }]);
    expect(parseRejectedSources("nonsense")).toEqual([]);
    expect(parseRejectedSources(null)).toEqual([]);
  });

  test("rejectedVideoIds / rejectedShas project the memory into the two filter sets", () => {
    const memory = [
      { at, reason: "x", sha256: "s1", videoId: "v1" },
      { at, reason: "y", sha256: "s2" },
    ];

    expect([...rejectedVideoIds(memory)]).toEqual(["v1"]);
    expect([...rejectedShas(memory)].sort()).toEqual(["s1", "s2"]);
  });
});
