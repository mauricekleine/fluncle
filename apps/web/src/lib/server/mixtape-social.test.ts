import { beforeEach, describe, expect, it, vi } from "vitest";

// The mixtape per-platform double-fire guard (lib/server/mixtape-social.ts;
// docs/rfcs/mobile-app.md §7). `finalizeMixtapeDistribution` is called ONCE PER
// PLATFORM (YouTube + Mixcloud both finalize), so a naive "the mixtape is
// published ⇒ notify" double-fires. The flip is a GUARDED
// `update ... where status = 'distributing'`; only the call whose guard changed a
// row (rowsAffected === 1) owns the transition and notifies. These tests pin that:
// the OWNING call notifies once; the second platform (rowsAffected === 0) does not.

const batch = vi.fn();
const getMixtapeById = vi.fn();
const purgeLogCache = vi.fn();
const notifyNewMixtape = vi.fn();

vi.mock("./db", () => ({
  getDb: async () => ({
    batch: (...args: unknown[]) => batch(...args),
  }),
  typedRows: <T>(rows: T[]): T[] => rows,
}));

vi.mock("./edge-cache", () => ({
  purgeLogCache: (...args: unknown[]) => purgeLogCache(...args),
}));

vi.mock("./mixtapes", () => ({
  getMixtapeById: (...args: unknown[]) => getMixtapeById(...args),
}));

vi.mock("./push", () => ({
  notifyNewMixtape: (...args: unknown[]) => notifyNewMixtape(...args),
}));

import { finalizeMixtapeDistribution } from "./mixtape-social";

const MIXTAPE = {
  artists: ["Fluncle"] as ["Fluncle"],
  externalUrls: {},
  logId: "2026.F.01",
  memberCount: 0,
  members: [],
  status: "published" as const,
  title: "Fluncle dreaming, vol. 1",
  type: "mixtape" as const,
};

// The three batch ResultSets the impl reads: [insert, guarded-flip, touch]. Only
// index [1] (the guarded flip) is read (`rowsAffected`), so set that one.
function batchResult(flipRowsAffected: number) {
  return [{ rowsAffected: 0 }, { rowsAffected: flipRowsAffected }, { rowsAffected: 1 }];
}

beforeEach(() => {
  batch.mockReset();
  getMixtapeById.mockReset();
  purgeLogCache.mockReset();
  notifyNewMixtape.mockReset();
  getMixtapeById.mockResolvedValue(MIXTAPE);
});

describe("finalizeMixtapeDistribution — single-owner notify", () => {
  it("notifies once when THIS call owns the distributing → published transition", async () => {
    batch.mockResolvedValue(batchResult(1));

    await finalizeMixtapeDistribution("mix_1", "youtube", { url: "https://youtu.be/x" });

    expect(notifyNewMixtape).toHaveBeenCalledTimes(1);
    expect(notifyNewMixtape).toHaveBeenCalledWith(MIXTAPE);
  });

  it("does NOT notify on the second platform (guard already flipped, rowsAffected 0)", async () => {
    batch.mockResolvedValue(batchResult(0));

    await finalizeMixtapeDistribution("mix_1", "mixcloud", { url: "https://mixcloud.com/x" });

    expect(notifyNewMixtape).not.toHaveBeenCalled();
  });

  it("fires exactly once across both platform finalizations of one mixtape", async () => {
    // First platform owns the flip (1), second sees it already done (0).
    batch.mockResolvedValueOnce(batchResult(1)).mockResolvedValueOnce(batchResult(0));

    await finalizeMixtapeDistribution("mix_1", "youtube", { url: "https://youtu.be/x" });
    await finalizeMixtapeDistribution("mix_1", "mixcloud", { url: "https://mixcloud.com/x" });

    expect(notifyNewMixtape).toHaveBeenCalledTimes(1);
  });

  it("still purges the cache regardless of who owns the transition", async () => {
    batch.mockResolvedValue(batchResult(0));

    await finalizeMixtapeDistribution("mix_1", "mixcloud", { url: "https://mixcloud.com/x" });

    expect(purgeLogCache).toHaveBeenCalledWith("2026.F.01");
  });
});
