import { describe, expect, test } from "bun:test";
import {
  appendRejectedSource,
  CONSENSUS_WINDOW_FRAMES,
  DEFAULT_MAX_BER,
  durationAgrees,
  fold,
  type ItunesReference,
  matchKey,
  MIN_OVERLAP_FRAMES,
  mutualWindowMatch,
  parseFpcalcJson,
  parseRejectedSources,
  pickSearchReference,
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

function randomFingerprint(length: number, seed: number): number[] {
  const out: number[] = [];
  let state = seed >>> 0;

  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out.push(state | 0);
  }

  return out;
}

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

    const preview = capture.slice(800, 1040);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result).not.toBeNull();
    expect(result?.ber).toBe(0);
    expect(result?.match).toBe(true);
    expect(result?.overlap).toBe(240);
  });

  test("an OFFSET match at a different position still finds the alignment", () => {
    const capture = randomFingerprint(2400, 7);

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

    expect(result?.ber).toBeGreaterThan(0.4);
    expect(result?.match).toBe(false);
  });

  test("a cross-source match with encoding noise still lands under the threshold", () => {
    const capture = randomFingerprint(2000, 314);

    const preview = addNoise(capture.slice(600, 840), 4, 55);

    const result = slidingWindowMatch(preview, capture, DEFAULT_MAX_BER);

    expect(result?.ber).toBeGreaterThan(0);
    expect(result?.ber).toBeLessThan(DEFAULT_MAX_BER);
    expect(result?.match).toBe(true);
  });

  test("THE THRESHOLD BOUNDARY: match is `ber <= threshold`, inclusive", () => {
    const base = randomFingerprint(40, 3);
    const noisy = addNoise(base, 1, 9);

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

describe("mutualWindowMatch (two full songs against EACH OTHER — the consensus comparison)", () => {
  test("two uploads of one recording agree at the genuine level, through a 30 s window from the middle", () => {
    const recording = randomFingerprint(2400, 21);

    const reupload = addNoise(recording, 1, 4);

    const result = mutualWindowMatch(recording, reupload, DEFAULT_MAX_BER);

    expect(result?.overlap).toBe(CONSENSUS_WINDOW_FRAMES);
    expect(result?.ber).toBeGreaterThan(0.02);
    expect(result?.ber).toBeLessThan(0.05);
    expect(result?.match).toBe(true);
  });

  test("a different EDIT of the same recording (a longer intro) still aligns — the window slides over the whole longer one", () => {
    const recording = randomFingerprint(2000, 22);

    const extended = [...randomFingerprint(300, 23), ...recording];

    const result = mutualWindowMatch(recording, extended, DEFAULT_MAX_BER);

    expect(result?.ber).toBe(0);
    expect(result?.match).toBe(true);
  });

  test("two different recordings do NOT agree — the ~0.5 random regime", () => {
    const result = mutualWindowMatch(
      randomFingerprint(2400, 24),
      randomFingerprint(2500, 25),
      DEFAULT_MAX_BER,
    );

    expect(result?.ber).toBeGreaterThan(0.4);
    expect(result?.match).toBe(false);
  });

  test("a fingerprint shorter than the window is compared whole; below the minimum overlap it abstains", () => {
    const short = randomFingerprint(100, 26);
    const long = [...randomFingerprint(50, 27), ...short, ...randomFingerprint(50, 28)];

    expect(mutualWindowMatch(short, long, DEFAULT_MAX_BER)?.overlap).toBe(100);
    expect(mutualWindowMatch(short, long, DEFAULT_MAX_BER)?.ber).toBe(0);
    expect(
      mutualWindowMatch(randomFingerprint(MIN_OVERLAP_FRAMES - 1, 29), long, DEFAULT_MAX_BER),
    ).toBeNull();
  });

  test("the window is ~30 s of Chromaprint frames, the preview gate's own scale", () => {
    expect(CONSENSUS_WINDOW_FRAMES).toBe(240);
    expect(CONSENSUS_WINDOW_FRAMES * 0.1238).toBeGreaterThan(29);
    expect(CONSENSUS_WINDOW_FRAMES * 0.1238).toBeLessThan(31);
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

describe("durationAgrees (the replicated capture tolerance)", () => {
  test("accepts within max(3s, 3%) and rejects beyond it", () => {
    expect(durationAgrees(201, 200_000)).toBe(true);
    expect(durationAgrees(206, 200_000)).toBe(true);
    expect(durationAgrees(207, 200_000)).toBe(false);
  });

  test("a missing/zero/negative target or candidate abstains (never trusts blind)", () => {
    expect(durationAgrees(200, undefined)).toBe(false);
    expect(durationAgrees(200, 0)).toBe(false);
    expect(durationAgrees(0, 200_000)).toBe(false);
    expect(durationAgrees(-5, 200_000)).toBe(false);
  });
});

describe("matchKey (the replicated folded identity)", () => {
  test("is order- and separator-agnostic across the artist set, and folds & ↔ and", () => {
    expect(matchKey(["A", "B"], "Song")).toBe(matchKey(["B", "A"], "Song"));
    expect(matchKey("A & B", "Song")).toBe(matchKey(["A", "and", "B"].join(", "), "Song"));
  });

  test("a remix/VIP is a DIFFERENT recording from the original", () => {
    expect(matchKey(["Calibre"], "Mr Majestic")).not.toBe(
      matchKey(["Calibre"], "Mr Majestic (VIP)"),
    );
    expect(fold("Where's Your Head At")).toBe("where s your head at");
  });
});

const hit = (over: Partial<ItunesReference>): ItunesReference => ({
  artistName: "Calibre",
  durationSec: 201,
  previewUrl: "https://itunes/preview/u1.m4a",
  trackName: "Mr Majestic",
  ...over,
});

describe("pickSearchReference (the precision heart — resolve one confident reference or abstain)", () => {
  const target = { artists: ["Calibre"], durationMs: 200_000, title: "Mr Majestic" };

  test("a confident identity+duration hit → its preview URL", () => {
    expect(pickSearchReference([hit({})], target)).toEqual({
      previewUrl: "https://itunes/preview/u1.m4a",
    });
  });

  test("zero hits → no-hit (abstain)", () => {
    expect(pickSearchReference([], target)).toEqual({ previewUrl: null, reason: "no-hit" });
  });

  test("an IDENTITY-mismatch hit is rejected as a reference → no-hit (a remix is not the original)", () => {
    const remix = hit({ trackName: "Mr Majestic (Loadstar Remix)" });

    expect(pickSearchReference([remix], target)).toEqual({ previewUrl: null, reason: "no-hit" });
  });

  test("a DURATION-disagree hit is rejected as a reference → no-hit", () => {
    const wrongLength = hit({ durationSec: 240, previewUrl: "https://itunes/preview/u3.m4a" });

    expect(pickSearchReference([wrongLength], target)).toEqual({
      previewUrl: null,
      reason: "no-hit",
    });
  });

  test("survivors that disagree on length with each other → conflict (never guess which recording)", () => {
    const a = hit({ durationSec: 195, previewUrl: "https://itunes/preview/a.m4a" });
    const b = hit({ durationSec: 205, previewUrl: "https://itunes/preview/b.m4a" });

    expect(pickSearchReference([a, b], target)).toEqual({ previewUrl: null, reason: "conflict" });
  });

  test("multiple survivors that AGREE on length are the same recording → the closest one resolves", () => {
    const near = hit({ durationSec: 200, previewUrl: "https://itunes/preview/near.m4a" });
    const far = hit({ durationSec: 202, previewUrl: "https://itunes/preview/far.m4a" });

    expect(pickSearchReference([far, near], target)).toEqual({
      previewUrl: "https://itunes/preview/near.m4a",
    });
  });

  test("no target duration → abstain (the duration guard cannot run, so nothing is trusted)", () => {
    expect(pickSearchReference([hit({})], { ...target, durationMs: undefined })).toEqual({
      previewUrl: null,
      reason: "no-hit",
    });
  });

  test("a hit with no preview URL is ignored", () => {
    expect(pickSearchReference([hit({ previewUrl: "" })], target)).toEqual({
      previewUrl: null,
      reason: "no-hit",
    });
  });
});
