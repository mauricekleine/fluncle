import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_RECS,
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  type RecommendationsResult,
} from "@/components/recommendations/shared";
import { type PublicUser } from "./public-auth";
import { buildRecsGate, type RecsGateDeps } from "./recs-gate";

// The gate's ONE invariant: a COMMITTED page view reads a stored edition and NEVER runs the
// engine (frontier-shelf-from-editions-rfc.md D3). Pinned off the DI seam — the engine, the
// reads, and the token mint are injected, so these are plain units with no database.

const USER: PublicUser = {
  createdAt: "2026-01-01T00:00:00.000Z",
  email: "crew@example.com",
  emailVerified: true,
  id: "u-1",
  name: "Crew",
};

const SUMMARY = (number: number): FrontierEditionSummary => ({
  number,
  refreshedAt: `2026-07-${String(number).padStart(2, "0")}T12:00:00.000Z`,
  seedsSkipped: [],
  seedsUsed: 0,
  trackCount: 33,
});

const DETAIL = (number: number): FrontierEditionDetail => ({
  summary: SUMMARY(number),
  tracks: [],
});

const RECS: RecommendationsResult = {
  catalogue: [],
  findings: [],
  ok: true,
  seedsSkipped: [],
  seedsUsed: 0,
};

function deps(over: Partial<RecsGateDeps> = {}): RecsGateDeps {
  return {
    createCsrfToken: () => "csrf-token",
    getFrontierEdition: vi.fn(async () => undefined),
    getFrontierEditions: vi.fn(async () => []),
    listRecSeeds: vi.fn(async () => ({ ok: true as const, seeds: [] })),
    runDraftEngine: vi.fn(async () => RECS),
    ...over,
  };
}

describe("buildRecsGate", () => {
  it("no session is anonymous — nothing is read", async () => {
    const d = deps();

    expect(await buildRecsGate(null, d)).toEqual({ state: "anonymous" });
    expect(d.runDraftEngine).not.toHaveBeenCalled();
    expect(d.getFrontierEditions).not.toHaveBeenCalled();
  });

  it("an unverified account is unverified — the engine is untouched", async () => {
    const d = deps();

    expect(await buildRecsGate({ ...USER, emailVerified: false }, d)).toEqual({
      state: "unverified",
    });
    expect(d.runDraftEngine).not.toHaveBeenCalled();
  });

  it("COMMITTED (≥1 edition) reads the latest edition and NEVER calls the engine", async () => {
    const getFrontierEdition = vi.fn(async () => DETAIL(2));
    const d = deps({
      getFrontierEdition,
      getFrontierEditions: vi.fn(async () => [SUMMARY(2), SUMMARY(1)]),
    });

    const gate = await buildRecsGate(USER, d);

    expect(d.runDraftEngine).not.toHaveBeenCalled();
    // The latest is the newest-first head — edition 2, not 1.
    expect(getFrontierEdition).toHaveBeenCalledWith("u-1", 2);

    if (gate.state !== "verified") {
      throw new Error("expected a verified gate");
    }

    expect(gate.recommendations).toEqual(EMPTY_RECS);
    expect(gate.latest).toEqual(DETAIL(2));
    expect(gate.editions).toHaveLength(2);
    expect(gate.stale).toBe(false);
  });

  it("COMMITTED flags stale when a pick moved since the edition froze", async () => {
    const d = deps({
      getFrontierEdition: vi.fn(async () => DETAIL(2)),
      getFrontierEditions: vi.fn(async () => [SUMMARY(2)]),
      listRecSeeds: vi.fn(async () => ({
        ok: true as const,
        seeds: [{ addedAt: "2026-07-20T00:00:00.000Z", artists: ["A"], title: "T", trackId: "t" }],
      })),
    });

    const gate = await buildRecsGate(USER, d);

    if (gate.state !== "verified") {
      throw new Error("expected a verified gate");
    }

    expect(gate.stale).toBe(true);
    expect(d.runDraftEngine).not.toHaveBeenCalled();
  });

  it("DRAFT (no edition) runs the engine and carries its live recommendations", async () => {
    const runDraftEngine = vi.fn(async () => RECS);
    const getFrontierEdition = vi.fn(async () => undefined);
    const d = deps({
      getFrontierEdition,
      getFrontierEditions: vi.fn(async () => []),
      runDraftEngine,
    });

    const gate = await buildRecsGate(USER, d);

    expect(runDraftEngine).toHaveBeenCalledWith(USER);
    expect(getFrontierEdition).not.toHaveBeenCalled();

    if (gate.state !== "verified") {
      throw new Error("expected a verified gate");
    }

    expect(gate.latest).toBeNull();
    expect(gate.stale).toBe(false);
    expect(gate.recommendations).toEqual(RECS);
  });
});
