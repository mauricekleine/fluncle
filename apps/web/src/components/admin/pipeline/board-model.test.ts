import { describe, expect, it } from "vitest";
import { type BoardRow } from "@/components/admin/use-publish";
import { boardSteps } from "./board-model";

// The Discogs cell is a workflow tracker whose FILL state is driven by `state`
// (`open` renders an un-filled icon; `done` a filled one — see step-node.tsx). A
// release can be linked by EITHER path: the on-add resolve (publishTrack writes
// `in_release_id` directly, never stamping `backfill_discogs_attempted_at`) or the
// backfill sweep (which stamps `discogsRan`, then skips already-linked findings).
// So a finding resolved on add carries `discogsReleaseUrl` but NOT `discogsRan` —
// it must still read `done`, otherwise a linked release shows an un-filled cell.

// A minimal published finding; the fields the Discogs cell reads are overridden per
// case. The rest only need to be present/array-shaped so `boardSteps` doesn't throw.
function makeRow(overrides: Partial<BoardRow>): BoardRow {
  return {
    addedAt: "2026-06-01T00:00:00.000Z",
    addedToSpotify: true,
    artists: ["Changing Faces"],
    discogsRan: false,
    discogsReleaseUrl: undefined,
    durationMs: 300000,
    enrichmentStatus: "done",
    hasContextNote: true,
    lastfmLoved: false,
    lastfmRan: false,
    mixtapes: [],
    noteRan: false,
    postedToTelegram: true,
    posts: [],
    spotifyUrl: "https://open.spotify.com/track/x",
    title: "Hypnotic",
    trackId: "x",
    ...overrides,
  } as BoardRow;
}

function discogsStep(row: BoardRow) {
  const step = boardSteps(row).find((s) => s.key === "discogs");

  if (!step) {
    throw new Error("discogs step missing");
  }

  return step;
}

describe("boardSteps — Discogs cell", () => {
  it("reads done (filled) when a release is linked on add, even without a backfill stamp", () => {
    // The regression: on-add resolve linked the release (`discogsReleaseUrl`) but the
    // backfill never ran (`discogsRan` false), so the cell used to render `open`.
    const step = discogsStep(
      makeRow({ discogsRan: false, discogsReleaseUrl: "https://www.discogs.com/release/1098936" }),
    );

    expect(step.state).toBe("done");
    expect(step.statusLabel).toBe("Linked");
    expect(step.actionable).toBe(true);
  });

  it("reads done (filled) when the backfill ran without finding a release", () => {
    const step = discogsStep(makeRow({ discogsRan: true, discogsReleaseUrl: undefined }));

    expect(step.state).toBe("done");
    expect(step.statusLabel).toBe("Checked — no release");
    expect(step.actionable).toBe(false);
  });

  it("reads open (un-filled) only when never resolved AND never swept", () => {
    const step = discogsStep(makeRow({ discogsRan: false, discogsReleaseUrl: undefined }));

    expect(step.state).toBe("open");
    expect(step.statusLabel).toBe("Pending");
  });
});
