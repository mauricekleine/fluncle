import { beforeEach, describe, expect, mock, test } from "bun:test";
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
    videoModel: undefined,
    videoModelReasoning: undefined,
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

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    requestedPaths.push(path);
    const url = new URL(path, "https://fluncle.test");
    const hasContext = url.searchParams.get("hasContext");

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

const { noteQueueCommand, queueCommand } = await import("./admin-tracks");

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

  test("a passed hasContext=false filter cannot un-gate the render queue", async () => {
    // The render queue is hard-gated: even if a caller passes `hasContext: false`
    // (the back-compat seam on QueueFilters), the queue still asks for the gated
    // set — the automation can never be tricked into filming note-less findings.
    await queueCommand(10, { hasContext: false });

    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    expect(url.searchParams.get("hasContext")).toBe("true");
  });
});
