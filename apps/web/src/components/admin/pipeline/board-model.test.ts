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
    hasEmbedding: false,
    lastfmLoved: false,
    lastfmRan: false,
    mixtapes: [],
    noteRan: false,
    plans: [],
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

// The Embeddings cell is a read-only presence tracker (like Last.fm/Discogs): its
// FILL is driven by `state` — `done` (filled gold check) once the finding carries a
// MuQ audio embedding (`embedding_json IS NOT NULL`, surfaced as `hasEmbedding`),
// `open` (hollow) while it's still in the embed cron's queue. No operator action — the
// on-box `fluncle-embed` cron advances it. This is the sonic fingerprint that
// superseded the retired manual vibe-map Tag cell (docs/audio-embedding-rfc.md).
function embeddingStep(row: BoardRow) {
  const step = boardSteps(row).find((s) => s.key === "embedding");

  if (!step) {
    throw new Error("embedding step missing");
  }

  return step;
}

describe("boardSteps — Embeddings cell", () => {
  it("reads done (filled) once the finding carries a MuQ embedding", () => {
    const step = embeddingStep(makeRow({ hasEmbedding: true }));

    expect(step.state).toBe("done");
    expect(step.statusLabel).toBe("Embedded");
    // A presence mark, not a click target — the embed cron advances it.
    expect(step.actionable).toBe(false);
  });

  it("reads open (hollow) while the finding is still in the embed queue", () => {
    const step = embeddingStep(makeRow({ hasEmbedding: false }));

    expect(step.state).toBe("open");
    expect(step.statusLabel).toBe("Pending");
    expect(step.actionable).toBe(false);
  });

  it("sits in the Agents group, right after Enrich and before Context", () => {
    const keys = boardSteps(makeRow({})).map((s) => s.key);
    const enrichAt = keys.indexOf("enrich");
    const embeddingAt = keys.indexOf("embedding");
    const contextAt = keys.indexOf("context");

    expect(embeddingAt).toBe(enrichAt + 1);
    expect(contextAt).toBe(embeddingAt + 1);
    // The retired Tag cell is gone entirely.
    expect(keys).not.toContain("tag");
  });
});

// The TikTok cell reads its state from the finding's `social_posts` row. The live
// bug: TikTok async-bounces the 6th+ pending inbox draft (Postiz still reports the
// push a success), so a `draft` row would read `partial`/gone-out forever. Past 24h
// (off `updatedAt`, the push time) the cell must re-open as a DISTINCT `stale` state —
// your move again — never silently merged with either the gold `partial` (in-flight)
// or the hollow "Push" (never pushed).
const NOW = Date.parse("2026-07-06T20:00:00.000Z");

function tiktokStep(row: BoardRow, now: number) {
  const step = boardSteps(row, now).find((s) => s.key === "tiktok");

  if (!step) {
    throw new Error("tiktok step missing");
  }

  return step;
}

function tiktokDraftRow(updatedAt: string): BoardRow {
  return makeRow({
    posts: [
      {
        createdAt: "2026-07-05T00:00:00.000Z",
        platform: "tiktok",
        status: "draft",
        updatedAt,
      },
    ],
    videoUrl: "https://found.fluncle.com/241.7.3A/footage.mp4",
  });
}

describe("boardSteps — TikTok publish cell (stale-draft rule)", () => {
  it("a FRESH draft (under 24h) reads partial/Drafted — it's genuinely in the inbox", () => {
    const step = tiktokStep(tiktokDraftRow("2026-07-06T18:00:00.000Z"), NOW);

    expect(step.state).toBe("partial");
    expect(step.statusLabel).toBe("Drafted");
    expect(step.actionable).toBe(true);
  });

  it("a STALE draft (past 24h, likely bounced) reads the distinct `stale` state + deadpan hint", () => {
    // 34h old → "Stale 34h".
    const step = tiktokStep(tiktokDraftRow("2026-07-05T10:00:00.000Z"), NOW);

    expect(step.state).toBe("stale");
    expect(step.statusLabel).toBe("Stale 34h");
    expect(step.hint).toBe("Draft stale 34h — likely bounced; re-push");
    // Still actionable — the Push dialog offers the re-push.
    expect(step.actionable).toBe(true);
  });

  it("a never-pushed TikTok cell reads a plain open 'Push' — distinct from a stale draft", () => {
    const step = tiktokStep(
      makeRow({ videoUrl: "https://found.fluncle.com/241.7.3A/footage.mp4" }),
      NOW,
    );

    expect(step.state).toBe("open");
    expect(step.statusLabel).toBe("Push");
  });

  it("a published TikTok post never reads stale, even if old", () => {
    const step = tiktokStep(
      makeRow({
        posts: [
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            platform: "tiktok",
            status: "published",
            updatedAt: "2026-01-01T00:00:00.000Z",
            url: "https://www.tiktok.com/@fluncle/video/1",
          },
        ],
        videoUrl: "https://found.fluncle.com/241.7.3A/footage.mp4",
      }),
      NOW,
    );

    expect(step.state).toBe("done");
    expect(step.statusLabel).toBe("Live");
  });
});
