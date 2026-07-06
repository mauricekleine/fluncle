import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type TrackListItem } from "@fluncle/contracts";
import * as realApi from "../api";

// A minimal finding row the mocked admin API returns. `hasContext` is not a wire
// field — the server derives the queue from `context_note is not null` — so the
// mock below stands in for that SQL gate: it only returns a finding when the
// caller asks for `hasContext=true`, exactly what `context_note is not null` does.
function finding(trackId: string, logId: string): TrackListItem {
  return {
    addedAt: "2026-06-21T00:00:00.000Z",
    addedToSpotify: false,
    album: "Album",
    albumImageUrl: undefined,
    artists: ["Artist"],
    bpm: undefined,
    durationMs: 0,
    enrichmentStatus: "done",
    isrc: undefined,
    key: undefined,
    label: undefined,
    logId,
    note: undefined,
    popularity: undefined,
    postedToTelegram: false,
    previewUrl: undefined,
    releaseDate: undefined,
    spotifyUrl: "https://open.spotify.com/track/x",
    title: "Song",
    trackId,
    type: "finding",
    videoGrain: undefined,
    videoModel: undefined,
    videoModelReasoning: undefined,
    videoRegister: undefined,
    videoUrl: undefined,
    videoVehicle: undefined,
  };
}

// The one context'd, video-less finding the queue should surface, plus a
// note-less finding that the `hasContext` gate must exclude.
const contextedFinding = finding("track_context", "001.1.1");

// Capture every admin API path the queue requests, and stand in for the server's
// SQL filter: a request carrying `hasContext=true` returns the context'd finding;
// without it, the server would also return the note-less finding (the bug the gate
// closes). The mock returns the note-less finding ONLY when `hasContext=true` is
// absent, so a test can prove the render queue never asks for the note-less one.
let requestedPaths: string[] = [];

// When set, the mock models a 2-page catalogue for a plain (unfiltered) list so an
// `--all` fetch must follow the cursor across pages. Off by default so the
// single-page queue/filter tests below keep asserting exactly one request.
let paginateCatalogue = false;

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    requestedPaths.push(path);
    const url = new URL(path, "https://fluncle.test");
    const hasContext = url.searchParams.get("hasContext");

    if (paginateCatalogue && hasContext === null && url.searchParams.get("hasKey") === null) {
      // Two pages: page 1 hands back a cursor, page 2 ends it. An --all fetch
      // (Infinity max) must request both; a finite limit would stop after page 1.
      const cursor = url.searchParams.get("cursor");
      return cursor
        ? { nextCursor: undefined, totalCount: 2, tracks: [finding("track_page2", "002.1.2")] }
        : { nextCursor: "page2", totalCount: 2, tracks: [finding("track_page1", "002.1.1")] };
    }

    // Model the server: `hasContext=true` ⇒ `context_note is not null`, so only
    // the context'd finding comes back. Absent the gate, a note-less finding would
    // leak into the render queue — that's the case this suite proves cannot happen.
    const tracks =
      hasContext === "true"
        ? [contextedFinding]
        : [contextedFinding, finding("track_no_context", "001.1.2")];

    return { nextCursor: undefined, totalCount: tracks.length, tracks };
  },
}));

const { contextQueueCommand, listCommand, noteQueueCommand, queueCommand } =
  await import("./admin-tracks");

describe("context queue — --retry-empty plumbing", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("the routine queue read omits retryEmptyContext (narrow sweep)", async () => {
    await contextQueueCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    // The every-tick context cron's worklist: findings missing field notes, oldest
    // first. Without the flag the widen param must be ABSENT so the server keeps
    // confirmed-empty finds out of the queue.
    expect(url.searchParams.get("hasContext")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.has("retryEmptyContext")).toBe(false);
  });

  test("--retry-empty widens the read with retryEmptyContext=true", async () => {
    await contextQueueCommand(10, true);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    // The occasional widen pass: still the `hasContext=false` queue (the only place
    // the server honours the flag), now also re-picking confirmed-empty finds.
    expect(url.searchParams.get("hasContext")).toBe("false");
    expect(url.searchParams.get("retryEmptyContext")).toBe("true");
  });
});

describe("auto-note queue — hasContext=true AND hasNote=false", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("requests the context'd-but-noteless worklist, oldest first", async () => {
    await noteQueueCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    // The note cron's worklist: findings with the context_note fuel on file but no
    // editorial note yet — the exact pairing observe uses, swapping hasObservation
    // for hasNote.
    expect(url.searchParams.get("hasContext")).toBe("true");
    expect(url.searchParams.get("hasNote")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
  });
});

describe("tracks list — key-backfill backlog filter", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("--no-key emits hasKey=false (the missing-key backlog query)", async () => {
    await listCommand({ hasKey: false, limit: 10, order: "desc" });

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    expect(url.searchParams.get("hasKey")).toBe("false");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  test("no key filter omits the hasKey param entirely (list all)", async () => {
    await listCommand({ limit: 10, order: "desc" });

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    expect(url.searchParams.has("hasKey")).toBe(false);
  });
});

describe("video render queue — hasContext hard-gate", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("always requests hasContext=true and hasVideo=false, oldest first", async () => {
    await queueCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    expect(url.searchParams.get("hasContext")).toBe("true");
    expect(url.searchParams.get("hasVideo")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  test("excludes a hasContext=false finding from the render queue", async () => {
    const tracks = await queueCommand(10);

    // The note-less finding never reaches the render queue: the gate makes the
    // request carry `hasContext=true`, so the server's `context_note is not null`
    // filter drops it. Only the context'd finding survives.
    const logIds = tracks.map((track) => track.logId);
    expect(logIds).toContain("001.1.1");
    expect(logIds).not.toContain("001.1.2");
  });
});

describe("tracks list — --all paginates the full catalogue", () => {
  beforeEach(() => {
    requestedPaths = [];
    paginateCatalogue = true;
  });

  afterEach(() => {
    paginateCatalogue = false;
  });

  test("an Infinity limit follows the cursor across every page", async () => {
    const tracks = await listCommand({ limit: Number.POSITIVE_INFINITY, order: "desc" });

    // Both pages fetched: the second request carries the page-1 cursor.
    expect(requestedPaths).toHaveLength(2);
    const secondUrl = new URL(requestedPaths[1] ?? "", "https://fluncle.test");
    expect(secondUrl.searchParams.get("cursor")).toBe("page2");

    // Findings from both pages are accumulated.
    const logIds = tracks.map((track) => track.logId);
    expect(logIds).toContain("002.1.1");
    expect(logIds).toContain("002.1.2");
  });

  test("a finite limit stops after the first page", async () => {
    const tracks = await listCommand({ limit: 1, order: "desc" });

    // max=1 is reached on page 1, so the cursor is never followed.
    expect(requestedPaths).toHaveLength(1);
    expect(tracks).toHaveLength(1);
  });
});
