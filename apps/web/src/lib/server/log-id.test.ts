import { describe, expect, it } from "vitest";
import { resolveLogId, sector } from "./log-id";

// The coordinate MINT. `resolveLogId` runs exactly twice in the app — the certification mint
// (publish.ts § resolveFindingLogId) and the `logId: "auto"` backfill (track-update.ts) — and
// what it returns is written to `findings.log_id` and never recomputed (log-id.ts's own header:
// "Permanent: computed once at add time and STORED"). So every property below is a PUBLIC
// contract the moment a finding is minted: the sector must stay chronological, the tail must
// stay derived from the recording's identity, and a collision must move the tail WITHOUT moving
// the sector. `log-id-shared.test.ts` pins the day-math underneath; this pins the mint on top.

const FOUND_AT = "2026-06-08T12:00:00.000Z";
const ISRC = "GBABC2600001";
const TRACK_ID = "3n3Ppam7vgaVa1iaRUc9Lp";

/** An `isTaken` that reports the given coordinates taken and everything else free. */
function taken(...coordinates: string[]): (candidate: string) => Promise<boolean> {
  const set = new Set(coordinates);

  return (candidate) => Promise.resolve(set.has(candidate));
}

const free = (): Promise<boolean> => Promise.resolve(false);

describe("sector — the chronological head of a coordinate", () => {
  it("zero-pads to three digits so it reads as a coordinate, not a counter", () => {
    expect(sector("2026-05-30T00:00:00.000Z")).toBe("000");
    expect(sector("2026-06-08T12:00:00.000Z")).toBe("009");
  });

  it("widens past three digits rather than truncating (the 2029 rollover)", () => {
    // Day 1024 after the epoch. A `.slice(-3)` style pad would silently alias this
    // onto sector 024 and collide two eras of coordinates.
    expect(sector("2029-03-19T00:00:00.000Z")).toBe("1024");
  });
});

describe("resolveLogId — the canonical candidate", () => {
  it("mints `sector.orbit.markL` and pins the algorithm on a golden value", async () => {
    // A golden, not just a shape check: the tail is an FNV-1a slice, so a refactor that
    // reorders the shifts still produces a well-formed coordinate while renaming every
    // finding that would be minted after it.
    await expect(
      resolveLogId({ foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID }, free),
    ).resolves.toBe("009.9.4H");
  });

  it("matches the documented shape: three-plus digits, an orbit digit, a mark digit + letter", async () => {
    const logId = await resolveLogId({ foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID }, free);

    expect(logId).toMatch(/^\d{3,}\.\d\.\d[A-Z]$/);
  });

  it("is deterministic — the same identity mints the same coordinate every time", async () => {
    const first = await resolveLogId({ foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID }, free);
    const second = await resolveLogId({ foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID }, free);

    expect(second).toBe(first);
  });

  it("seeds off the ISRC when there is one — the same recording keeps one tail across Spotify ids", async () => {
    const viaOneId = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: "spotify-a" },
      free,
    );
    const viaAnother = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: "spotify-b" },
      free,
    );

    expect(viaAnother).toBe(viaOneId);
    expect(viaOneId).toBe("009.9.4H");
  });

  it("falls back to the Spotify id when the ISRC is absent, null, or blank", async () => {
    const expected = "009.5.0U";

    await expect(resolveLogId({ foundAt: FOUND_AT, trackId: TRACK_ID }, free)).resolves.toBe(
      expected,
    );
    await expect(
      resolveLogId({ foundAt: FOUND_AT, isrc: null, trackId: TRACK_ID }, free),
    ).resolves.toBe(expected);
    // A whitespace-only ISRC is not an identity. `isrc?.trim() || trackId` is what makes it
    // fall through; a `??` there would seed the hash on "   " and mint a nonsense tail.
    await expect(
      resolveLogId({ foundAt: FOUND_AT, isrc: "   ", trackId: TRACK_ID }, free),
    ).resolves.toBe(expected);
  });
});

describe("resolveLogId — collision resolution", () => {
  it("keeps the sector and takes a fresh tail when the canonical candidate is taken", async () => {
    const logId = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID },
      taken("009.9.4H"),
    );

    // Chronology is fixed: a collision NEVER moves the finding to another day.
    expect(logId.startsWith("009.")).toBe(true);
    expect(logId).not.toBe("009.9.4H");
    expect(logId).toMatch(/^\d{3,}\.\d\.\d[A-Z]$/);
  });

  it("walks salted attempts in order, so resolution is itself deterministic", async () => {
    const first = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID },
      taken("009.9.4H"),
    );
    const second = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID },
      taken("009.9.4H"),
    );
    const third = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID },
      taken("009.9.4H", first),
    );

    expect(second).toBe(first);
    // Blocking attempt 0 AND attempt 1 walks on rather than looping on a used tail.
    expect(third).not.toBe(first);
    expect(third.startsWith("009.")).toBe(true);
  });

  it("asks `isTaken` once per attempt and stops at the first free coordinate", async () => {
    const asked: string[] = [];
    const blocked = new Set(["009.9.4H"]);

    const logId = await resolveLogId(
      { foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID },
      (candidate) => {
        asked.push(candidate);

        return Promise.resolve(blocked.has(candidate));
      },
    );

    expect(asked).toEqual(["009.9.4H", logId]);
  });

  it("throws rather than returning a duplicate when all 64 attempts are taken", async () => {
    let asked = 0;

    await expect(
      resolveLogId({ foundAt: FOUND_AT, isrc: ISRC, trackId: TRACK_ID }, () => {
        asked += 1;

        return Promise.resolve(true);
      }),
    ).rejects.toThrow("log-id: exhausted attempts resolving a unique coordinate");

    // The bound is the loop's own, not the caller's: a silent `undefined` here would land
    // a NOT NULL violation (or worse, a duplicate coordinate) far from the cause.
    expect(asked).toBe(64);
  });
});
