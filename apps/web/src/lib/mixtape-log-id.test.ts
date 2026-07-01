import { describe, expect, it } from "vitest";
import { mixtapeLogId, mixtapeTail, predictedMixtapeLogId } from "./mixtape-log-id";

describe("mixtape Log ID minting", () => {
  it("encodes the 1A..9F tail sequence", () => {
    expect(mixtapeTail(1)).toBe("1A");
    expect(mixtapeTail(6)).toBe("1F");
    expect(mixtapeTail(7)).toBe("2A");
    expect(mixtapeTail(54)).toBe("9F");
    expect(() => mixtapeTail(55)).toThrow("between 1 and 54");
  });

  it("mints the first recorded 2026-06-18 mixtape as 019.F.1A", () => {
    expect(mixtapeLogId("2026-06-18T20:00:00.000Z", 1)).toBe("019.F.1A");
  });
});

describe("predictedMixtapeLogId — the reserved coordinate", () => {
  it("reproduces mixtape #1's coordinate from its recorded date (seq 1 → 019.F.1A)", () => {
    expect(predictedMixtapeLogId({ nextSequence: 1, recordedAt: "2026-06-18T20:00:00.000Z" })).toBe(
      "019.F.1A",
    );
  });

  it("reserves the next draft off its live session (2026-07-01, seq 2 → 032.F.1B)", () => {
    expect(predictedMixtapeLogId({ nextSequence: 2, plannedFor: "2026-07-01T20:00:00.000Z" })).toBe(
      "032.F.1B",
    );
  });

  it("lets the live session win over the recorded date (the committed record day)", () => {
    expect(
      predictedMixtapeLogId({
        nextSequence: 1,
        plannedFor: "2026-07-01T20:00:00.000Z",
        recordedAt: "2026-06-18T20:00:00.000Z",
      }),
    ).toBe("032.F.1A");
  });

  it("falls back to the recorded date when there is no live session", () => {
    expect(predictedMixtapeLogId({ nextSequence: 1, recordedAt: "2026-06-18T20:00:00.000Z" })).toBe(
      "019.F.1A",
    );
  });

  it("returns undefined with no date basis — no drifting today-based guess", () => {
    expect(predictedMixtapeLogId({ nextSequence: 1 })).toBeUndefined();
    expect(
      predictedMixtapeLogId({ nextSequence: 1, plannedFor: "  ", recordedAt: null }),
    ).toBeUndefined();
  });

  it("returns undefined once the spine is full (sequence past 54)", () => {
    expect(
      predictedMixtapeLogId({ nextSequence: 55, recordedAt: "2026-06-18T20:00:00.000Z" }),
    ).toBeUndefined();
  });
});
