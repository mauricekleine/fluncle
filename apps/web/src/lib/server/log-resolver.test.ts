import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLogPageTarget, resolveMusicTarget } from "./log-resolver";

// THE ARCHIVE'S DEEPEST RAIL: a visitor is never shown the wrong KIND of object.
//
// Three objects share the `/log/<id>` spine — a finding (a digit in the marker slot),
// a mixtape (`F`), a letter (`L`). These prove the resolver sends each coordinate to
// exactly one store, that a coordinate never falls through to a neighbouring kind when
// its own object is missing, and that the music-only surfaces (get_track, oEmbed, the
// embed card) can't be handed a letter.

const getEditionByLogId = vi.hoisted(() => vi.fn());
const getMixtapeByLogId = vi.hoisted(() => vi.fn());
const getTrackByIdOrLogId = vi.hoisted(() => vi.fn());

vi.mock("./editions", () => ({ getEditionByLogId }));
vi.mock("./mixtapes", () => ({ getMixtapeByLogId }));
vi.mock("./tracks", () => ({ getTrackByIdOrLogId }));

const FINDING = "004.7.2I";
const MIXTAPE = "019.F.1A";
const LETTER = "020.L.1A";

beforeEach(() => {
  getEditionByLogId.mockReset().mockResolvedValue({ logId: LETTER, number: 1 });
  getMixtapeByLogId.mockReset().mockResolvedValue({ logId: MIXTAPE, title: "Mixtape #1" });
  getTrackByIdOrLogId.mockReset().mockResolvedValue({ logId: FINDING, title: "A banger" });
});

describe("resolveLogPageTarget (the /log/<id> resolver)", () => {
  it("sends each coordinate to exactly one store", async () => {
    await expect(resolveLogPageTarget(FINDING)).resolves.toMatchObject({ kind: "track" });
    await expect(resolveLogPageTarget(MIXTAPE)).resolves.toMatchObject({ kind: "mixtape" });
    await expect(resolveLogPageTarget(LETTER)).resolves.toMatchObject({ kind: "edition" });

    expect(getTrackByIdOrLogId).toHaveBeenCalledTimes(1);
    expect(getMixtapeByLogId).toHaveBeenCalledTimes(1);
    expect(getEditionByLogId).toHaveBeenCalledTimes(1);
    // The letter was never looked for among the tracks, nor the finding among the
    // letters: the marker slot decides before a single read.
    expect(getTrackByIdOrLogId).not.toHaveBeenCalledWith(LETTER);
    expect(getEditionByLogId).not.toHaveBeenCalledWith(FINDING);
  });

  it("resolves nothing — never a neighbouring kind — when the object is missing", async () => {
    getEditionByLogId.mockResolvedValue(undefined);
    getMixtapeByLogId.mockResolvedValue(undefined);
    getTrackByIdOrLogId.mockResolvedValue(undefined);

    await expect(resolveLogPageTarget(LETTER)).resolves.toBeUndefined();
    await expect(resolveLogPageTarget(MIXTAPE)).resolves.toBeUndefined();
    await expect(resolveLogPageTarget(FINDING)).resolves.toBeUndefined();
    // A missing letter did NOT fall through to a track lookup (which is what would
    // let a stray row surface under a letter's coordinate).
    expect(getTrackByIdOrLogId).not.toHaveBeenCalledWith(LETTER);
  });

  it("still resolves a legacy Spotify track id to its finding", async () => {
    await expect(resolveLogPageTarget("6Y44zcYp0vUkmKCBve1Epr")).resolves.toMatchObject({
      kind: "track",
    });
  });
});

describe("resolveMusicTarget (the music-only surfaces)", () => {
  it("resolves a finding and a mixtape", async () => {
    await expect(resolveMusicTarget(FINDING)).resolves.toMatchObject({ kind: "track" });
    await expect(resolveMusicTarget(MIXTAPE)).resolves.toMatchObject({ kind: "mixtape" });
  });

  it("never hands a letter to a surface that can only speak about music", async () => {
    getTrackByIdOrLogId.mockResolvedValue(undefined);

    await expect(resolveMusicTarget(LETTER)).resolves.toBeUndefined();
    expect(getEditionByLogId).not.toHaveBeenCalled();
  });
});
