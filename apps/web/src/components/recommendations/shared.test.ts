import { describe, expect, it } from "vitest";
import {
  foldFrontierMint,
  foldFrontierStatus,
  FRONTIER_CLOSED,
  type FrontierEditionSummary,
  resolveGateState,
  resolveOpenSummary,
  savedFindingBody,
  SEED_CAP,
  seedMutationMessage,
} from "./shared";

const EDITION = (number: number): FrontierEditionSummary => ({
  number,
  refreshedAt: `2026-07-${String(number).padStart(2, "0")}T12:00:00.000Z`,
  trackCount: 33,
});

// The /recommendations door is component-light by design; its judgment lives in PURE folds.
// These pin what the reader sees: which gate state renders, how the frontier endpoint folds
// to "closed", how the 12-seed cap's 409 surfaces, which past edition the dropdown opens, and
// the register-aware save body (a finding carries its Log ID, a catalogue cut does not).

describe("SEED_CAP", () => {
  it("mirrors the server's MAX_REC_SEEDS (12) — the picked-state UI's cap", () => {
    // A drift guard: the server 409s a breach at MAX_REC_SEEDS; this literal only decides when
    // an un-picked row disables, so the two must agree or the UI disables at the wrong count.
    expect(SEED_CAP).toBe(12);
  });
});

describe("resolveGateState", () => {
  it("no session is anonymous", () => {
    expect(resolveGateState(null)).toBe("anonymous");
    expect(resolveGateState(undefined)).toBe("anonymous");
  });

  it("a signed-in but unverified account is unverified", () => {
    expect(resolveGateState({ emailVerified: false })).toBe("unverified");
  });

  it("a verified account opens the working surface", () => {
    expect(resolveGateState({ emailVerified: true })).toBe("verified");
  });
});

describe("foldFrontierStatus", () => {
  it("folds a 404 (the parallel endpoint hasn't merged) to closed, never an error", () => {
    expect(foldFrontierStatus({ body: undefined, ok: false, status: 404 })).toEqual(
      FRONTIER_CLOSED,
    );
  });

  it("folds any non-ok status to closed", () => {
    expect(foldFrontierStatus({ body: { ok: false }, ok: false, status: 500 })).toEqual(
      FRONTIER_CLOSED,
    );
  });

  it("folds a shapeless body to closed", () => {
    expect(foldFrontierStatus({ body: "not json", ok: true, status: 200 })).toEqual(
      FRONTIER_CLOSED,
    );
  });

  it("reads mintingOpen and the playlist through a healthy body", () => {
    expect(
      foldFrontierStatus({
        body: {
          lastSyncedAt: "2026-07-16T00:00:00.000Z",
          mintingOpen: true,
          ok: true,
          playlistUrl: "https://open.spotify.com/playlist/abc",
        },
        ok: true,
        status: 200,
      }),
    ).toEqual({
      lastSyncedAt: "2026-07-16T00:00:00.000Z",
      mintingOpen: true,
      playlistUrl: "https://open.spotify.com/playlist/abc",
    });
  });

  it("a healthy body with minting off but no playlist stays open with no URL", () => {
    expect(
      foldFrontierStatus({ body: { mintingOpen: false, ok: true }, ok: true, status: 200 }),
    ).toEqual({ lastSyncedAt: undefined, mintingOpen: false, playlistUrl: undefined });
  });
});

describe("foldFrontierMint", () => {
  it("folds a 404 to closed (button goes disabled-quiet)", () => {
    expect(foldFrontierMint({ body: undefined, ok: false, status: 404 })).toEqual({
      kind: "closed",
    });
  });

  it("folds a switch_off status to closed", () => {
    expect(
      foldFrontierMint({ body: { ok: true, status: "switch_off" }, ok: true, status: 200 }),
    ).toEqual({ kind: "closed" });
  });

  it("carries a minted/refreshed/unchanged status and its URL through", () => {
    expect(
      foldFrontierMint({
        body: { ok: true, playlistUrl: "https://open.spotify.com/playlist/x", status: "minted" },
        ok: true,
        status: 200,
      }),
    ).toEqual({ kind: "ok", playlistUrl: "https://open.spotify.com/playlist/x", status: "minted" });
  });

  it("a non-ok response is a plain error line", () => {
    expect(foldFrontierMint({ body: { message: "Rate limited" }, ok: false, status: 429 })).toEqual(
      {
        kind: "error",
        message: "Rate limited",
      },
    );
  });
});

describe("seedMutationMessage", () => {
  it("is silent on success", () => {
    expect(seedMutationMessage({ body: { ok: true }, ok: true, status: 200 })).toBe("");
  });

  it("is silent on a 401 (a redirect handles it)", () => {
    expect(seedMutationMessage({ body: undefined, ok: false, status: 401 })).toBe("");
  });

  it("surfaces the server's 12-seed-cap 409 message verbatim", () => {
    expect(
      seedMutationMessage({
        body: {
          code: "seed_limit",
          message: "You can pick up to 12 seeds. Remove one to add another.",
          ok: false,
        },
        ok: false,
        status: 409,
      }),
    ).toBe("You can pick up to 12 seeds. Remove one to add another.");
  });

  it("falls back to a cap line if a 409 arrives without a message", () => {
    expect(seedMutationMessage({ body: {}, ok: false, status: 409 })).toBe(
      "You can pick up to 12 seeds. Remove one to add another.",
    );
  });

  it("a non-cap failure is a quiet, non-blaming line", () => {
    expect(seedMutationMessage({ body: undefined, ok: false, status: 500 })).toBe(
      "Could not update your seeds. Try again in a moment.",
    );
  });
});

describe("resolveOpenSummary", () => {
  const editions = [EDITION(3), EDITION(2), EDITION(1)];

  it("a null openNumber selects nothing — the dialog stays closed", () => {
    expect(resolveOpenSummary(editions, null)).toBeNull();
  });

  it("resolves the summary whose number matches the opened one", () => {
    expect(resolveOpenSummary(editions, 2)).toEqual(EDITION(2));
  });

  it("a number no longer in the list resolves to null, never a wrong edition", () => {
    expect(resolveOpenSummary(editions, 9)).toBeNull();
  });
});

describe("savedFindingBody", () => {
  it("a finding carries its Log ID so the save stores it", () => {
    expect(savedFindingBody({ logId: "241.7.3A", trackId: "t-1" })).toEqual({
      logId: "241.7.3A",
      trackId: "t-1",
    });
  });

  it("a catalogue cut has no coordinate — it sends only its track id", () => {
    expect(savedFindingBody({ trackId: "t-2" })).toEqual({ trackId: "t-2" });
  });
});
