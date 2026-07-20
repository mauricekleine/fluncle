import { describe, expect, it } from "vitest";
import {
  foldFrontierMint,
  foldFrontierStatus,
  FRONTIER_CLOSED,
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  isEditionStale,
  mintToastMessage,
  type RecSeedItem,
  resolveGateState,
  resolveOpenSummary,
  resolvePlaylistCta,
  savedFindingBody,
  SEED_CAP,
  seedMutationMessage,
  skippedSeedsLine,
} from "./shared";

const EDITION = (number: number): FrontierEditionSummary => ({
  number,
  refreshedAt: `2026-07-${String(number).padStart(2, "0")}T12:00:00.000Z`,
  trackCount: 33,
});

/** A frozen edition detail whose summary carries the seed meta, for the staleness truth table.
 *  `refreshedAt` is fixed mid-window so seeds can sit clearly before or after the freeze. */
const detail = (over: Partial<FrontierEditionSummary> = {}): FrontierEditionDetail => ({
  summary: {
    number: 1,
    refreshedAt: "2026-07-10T12:00:00.000Z",
    seedsSkipped: [],
    seedsUsed: 2,
    trackCount: 33,
    ...over,
  },
  tracks: [],
});

const seed = (trackId: string, addedAt: string): RecSeedItem => ({
  addedAt,
  artists: ["A"],
  title: "T",
  trackId,
});

const BEFORE = "2026-07-09T12:00:00.000Z";
const AFTER = "2026-07-11T12:00:00.000Z";

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

  it("carries an edition_only status through as ok (minting dark — the edition was born)", () => {
    expect(
      foldFrontierMint({ body: { ok: true, status: "edition_only" }, ok: true, status: 200 }),
    ).toEqual({ kind: "ok", playlistUrl: undefined, status: "edition_only" });
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

  it("carries a building status through as ok (budget spent — the create was deferred)", () => {
    expect(
      foldFrontierMint({ body: { ok: true, status: "building" }, ok: true, status: 200 }),
    ).toEqual({ kind: "ok", playlistUrl: undefined, status: "building" });
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

describe("mintToastMessage", () => {
  it("edition_only confirms the save with the Spotify half still to come (minting dark)", () => {
    expect(mintToastMessage("edition_only")).toBe("Saved. Your Spotify playlist follows soon.");
  });

  it("reuses the mirror's lines verbatim for minted/refreshed/unchanged", () => {
    expect(mintToastMessage("minted")).toBe("Done. It's on your Spotify.");
    expect(mintToastMessage("refreshed")).toBe("Refreshed with your latest picks.");
    expect(mintToastMessage("unchanged")).toBe("Already up to date.");
  });

  it("building reassures that the deferred playlist is coming (budget spent, minting open)", () => {
    expect(mintToastMessage("building")).toBe("Saved. Your Spotify playlist is on its way.");
  });
});

describe("skippedSeedsLine", () => {
  it("names one skipped pick in the singular", () => {
    expect(skippedSeedsLine(1)).toBe(
      "One of your picks isn't steering yet. Fluncle hasn't got its audio.",
    );
  });

  it("names several in the plural with the count", () => {
    expect(skippedSeedsLine(3)).toBe(
      "3 of your picks aren't steering yet. Fluncle hasn't got their audio.",
    );
  });
});

describe("isEditionStale", () => {
  it("no change — every pick predates the freeze and the count matches — is not stale", () => {
    const seeds = [seed("a", BEFORE), seed("b", BEFORE)];

    expect(isEditionStale(detail({ seedsSkipped: [], seedsUsed: 2 }), seeds)).toBe(false);
  });

  it("a pick added after the freeze is stale (the addedAt half)", () => {
    const seeds = [seed("a", BEFORE), seed("b", AFTER)];

    expect(isEditionStale(detail({ seedsSkipped: [], seedsUsed: 2 }), seeds)).toBe(true);
  });

  it("a pick removed since the freeze is stale (the count half)", () => {
    const seeds = [seed("a", BEFORE)];

    expect(isEditionStale(detail({ seedsSkipped: [], seedsUsed: 2 }), seeds)).toBe(true);
  });

  it("a swap (one removed, one added) is stale via the added pick's addedAt", () => {
    const seeds = [seed("a", BEFORE), seed("c", AFTER)];

    expect(isEditionStale(detail({ seedsSkipped: [], seedsUsed: 2 }), seeds)).toBe(true);
  });

  it("the frozen count includes skipped seeds, so a matching total is not stale", () => {
    const seeds = [seed("a", BEFORE), seed("b", BEFORE)];

    // Frozen: 1 steered + 1 skipped = 2 total; current 2 all pre-freeze → no drift.
    expect(isEditionStale(detail({ seedsSkipped: ["z"], seedsUsed: 1 }), seeds)).toBe(false);
  });

  it("pre-migration NULL meta never nudges on the count half", () => {
    const seeds = [seed("a", BEFORE)];

    // seedsUsed/seedsSkipped undefined — the count comparison is skipped; every pick predates
    // the freeze, so the honest answer is not-stale even though the count would differ.
    expect(isEditionStale(detail({ seedsSkipped: undefined, seedsUsed: undefined }), seeds)).toBe(
      false,
    );
  });

  it("NULL meta still catches a pick added after the freeze (the addedAt half is meta-free)", () => {
    const seeds = [seed("a", AFTER)];

    expect(isEditionStale(detail({ seedsSkipped: undefined, seedsUsed: undefined }), seeds)).toBe(
      true,
    );
  });
});

describe("resolvePlaylistCta", () => {
  it("the draft phase offers the one-time Get playlist commitment", () => {
    expect(resolvePlaylistCta({ phase: "draft" })).toEqual({ kind: "get-playlist" });
  });

  it("committed with a playlist URL opens it on Spotify", () => {
    expect(
      resolvePlaylistCta({
        phase: "committed",
        playlistUrl: "https://open.spotify.com/playlist/x",
      }),
    ).toEqual({ kind: "open", url: "https://open.spotify.com/playlist/x" });
  });

  it("committed with no URL yet (edition_only, Spotify half dark) waits — no control", () => {
    expect(resolvePlaylistCta({ phase: "committed" })).toEqual({ kind: "waiting" });
  });

  it("the committed phase NEVER exposes the mint gesture — no user path back into the engine", () => {
    // The engine's only user trigger is the one-time draft commitment; a committed page view
    // must offer no button that re-runs it. Whether or not a playlist exists, the CTA is
    // `open` or `waiting`, never `get-playlist`.
    expect(resolvePlaylistCta({ phase: "committed" }).kind).not.toBe("get-playlist");
    expect(
      resolvePlaylistCta({ phase: "committed", playlistUrl: "https://open.spotify.com/playlist/x" })
        .kind,
    ).not.toBe("get-playlist");
  });
});
