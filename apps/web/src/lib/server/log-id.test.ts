import { describe, expect, it } from "vitest";
import { resolveLogId, sector } from "./log-id";

const FOUND_AT = "2026-06-08T12:00:00.000Z";
const ISRC = "GBABC2600001";
const TRACK_ID = "3n3Ppam7vgaVa1iaRUc9Lp";

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
    expect(sector("2029-03-19T00:00:00.000Z")).toBe("1024");
  });
});

describe("resolveLogId — the canonical candidate", () => {
  it("mints `sector.orbit.markL` and pins the algorithm on a golden value", async () => {
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

    expect(asked).toBe(64);
  });
});
