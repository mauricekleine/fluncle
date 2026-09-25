import { describe, expect, it } from "vitest";
import { type BoardRow } from "@/components/admin/use-publish";
import { automatedSocialsBreakdown, type BoardActions, boardSteps, runStep } from "./board-model";

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

    expect(step.actionable).toBe(true);
  });

  it("reads open (hollow) while the finding is still in the embed queue", () => {
    const step = embeddingStep(makeRow({ hasEmbedding: false }));

    expect(step.state).toBe("open");
    expect(step.statusLabel).toBe("Pending");
    expect(step.actionable).toBe(true);
  });

  it("dispatches its click to the capture-source dialog and nowhere else", () => {
    const row = makeRow({ hasEmbedding: false });
    const opened: string[] = [];
    const actions: BoardActions = {
      onCaptureSource: (target) => opened.push(`source:${target.trackId}`),
      onContext: () => opened.push("context"),
      onEnrich: () => opened.push("enrich"),
      onMixtape: () => opened.push("mixtape"),
      onNote: () => opened.push("note"),
      onObservation: () => opened.push("observation"),
      onPreview: () => opened.push("preview"),
      onPush: () => opened.push("push"),
    };

    runStep(embeddingStep(row), row, actions);

    expect(opened).toEqual([`source:${row.trackId}`]);
  });

  it("sits in the Agents group, right after Enrich and before Context", () => {
    const keys = boardSteps(makeRow({})).map((s) => s.key);
    const enrichAt = keys.indexOf("enrich");
    const embeddingAt = keys.indexOf("embedding");
    const contextAt = keys.indexOf("context");

    expect(embeddingAt).toBe(enrichAt + 1);
    expect(contextAt).toBe(embeddingAt + 1);

    expect(keys).not.toContain("tag");
  });
});

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
    const step = tiktokStep(tiktokDraftRow("2026-07-05T10:00:00.000Z"), NOW);

    expect(step.state).toBe("stale");
    expect(step.statusLabel).toBe("Stale 34h");
    expect(step.hint).toBe("Draft stale 34h — likely bounced; re-push");

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

function socialsStep(row: BoardRow) {
  const step = boardSteps(row).find((s) => s.key === "socials");

  if (!step) {
    throw new Error("socials step missing");
  }

  return step;
}

describe("boardSteps — automated-socials cell", () => {
  it("is open/Pending when Last.fm hasn't run", () => {
    const step = socialsStep(makeRow({ lastfmRan: false }));

    expect(step.state).toBe("open");
    expect(step.statusLabel).toBe("Pending");
    expect(step.actionable).toBe(false);
  });

  it("is done/All when the Last.fm love has run", () => {
    const step = socialsStep(makeRow({ lastfmRan: true }));

    expect(step.state).toBe("done");
    expect(step.statusLabel).toBe("All");
  });

  it("breaks the action down for the Popover — the Last.fm love", () => {
    const items = automatedSocialsBreakdown(makeRow({ lastfmLoved: true, lastfmRan: true }));

    expect(items.map((item) => item.key)).toEqual(["lastfm"]);
    expect(items[0]?.label).toBe("Last.fm — loved");
    expect(items[0]?.done).toBe(true);
  });
});
