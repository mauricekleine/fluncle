import { beforeEach, describe, expect, it, vi } from "vitest";

const listTracks = vi.hoisted(() => vi.fn());
const updateTrack = vi.hoisted(() => vi.fn());
const runsCreate = vi.hoisted(() => vi.fn());

vi.mock("./tracks", () => ({ listTracks }));
vi.mock("./track-update", () => ({ updateTrack }));
vi.mock("@getspinup/sdk", () => ({
  createSpinupClient: () => ({ agents: { runs: { create: runsCreate } } }),
}));

import { sweepEnrichmentQueue } from "./spinup";

// A queued page: a stale-processing track (the headline case — it MUST be
// re-fired, not just `failed`), a failed one, and one with no Log ID yet (the
// R2 key is missing, so it can't be enriched and is skipped, not crashed).
function queuePage() {
  return {
    tracks: [
      {
        enrichmentStatus: "processing",
        logId: "005.1.1A",
        trackId: "t-processing-stale",
        type: "finding",
      },
      { enrichmentStatus: "failed", logId: "002.1.1A", trackId: "t-failed", type: "finding" },
      { enrichmentStatus: "pending", logId: undefined, trackId: "t-no-logid", type: "finding" },
    ],
  };
}

beforeEach(() => {
  process.env.SPINUP_ENRICH_AGENT_ID = "agent_test";
  process.env.SPINUP_ENRICH_AGENT_KEY = "sk_agent_test";
  listTracks.mockReset();
  updateTrack.mockReset();
  runsCreate.mockReset();
  runsCreate.mockImplementation(async ({ idempotencyKey }: { idempotencyKey: string }) => ({
    run: { id: `run-for-${idempotencyKey}` },
  }));
  listTracks.mockResolvedValue(queuePage());
});

describe("sweepEnrichmentQueue (the self-healing sweep)", () => {
  it("reads the queue oldest-first via the 'queue' status filter", async () => {
    await sweepEnrichmentQueue(25);

    expect(listTracks).toHaveBeenCalledWith({ limit: 25, order: "asc", status: "queue" });
  });

  it("re-fires a stale processing track (not only failed ones)", async () => {
    const result = await sweepEnrichmentQueue(25);

    expect(result.reEnriched.map((e) => e.trackId)).toContain("t-processing-stale");
    // It re-enters processing through the normal trigger path.
    expect(updateTrack).toHaveBeenCalledWith("t-processing-stale", {
      enrichmentStatus: "processing",
    });
  });

  it("keys every run by enrich:<logId> so a repeated sweep cannot duplicate an in-flight run", async () => {
    await sweepEnrichmentQueue(25);
    await sweepEnrichmentQueue(25);

    const keys = runsCreate.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );

    // Both sweeps produced the SAME idempotency keys — Spinup de-dupes on its
    // side, so the second sweep is a no-op for any run already in flight.
    expect(keys).toEqual([
      "enrich:005.1.1A",
      "enrich:002.1.1A",
      "enrich:005.1.1A",
      "enrich:002.1.1A",
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("skips a queued finding with no Log ID instead of crashing the sweep", async () => {
    const result = await sweepEnrichmentQueue(25);

    expect(result.skipped.map((e) => e.trackId)).toEqual(["t-no-logid"]);
    // The skipped one never reaches Spinup.
    const keys = runsCreate.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).not.toContain("enrich:undefined");
    expect(keys).not.toContain("enrich:");
  });

  it("returns empty when nothing is queued", async () => {
    listTracks.mockResolvedValueOnce({ tracks: [] });

    const result = await sweepEnrichmentQueue(25);

    expect(result.reEnriched).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(runsCreate).not.toHaveBeenCalled();
  });
});
