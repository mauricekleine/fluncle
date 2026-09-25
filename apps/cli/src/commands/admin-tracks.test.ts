import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type TrackListItem } from "@fluncle/contracts";
import * as realApi from "../api";

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

const contextedFinding = finding("track_context", "001.1.1");

const videoedFinding: TrackListItem = {
  ...finding("track_videoed", "003.3.3"),
  videoGrain: "grainCoarseSilver",
  videoPalette: "amber-warm",
  videoRegister: "representational",
  videoUrl: "https://found.fluncle.com/003.3.3/footage.mp4",
  videoVehicle: "derelict hull",
};

const capturedFinding: TrackListItem = {
  ...finding("track_captured", "004.6.0Q"),
  sourceAudioKey: "004.6.0Q/deadbeef.m4a",
};

let requestedPaths: string[] = [];

let paginateCatalogue = false;

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    requestedPaths.push(path);
    const url = new URL(path, "https://fluncle.test");
    const hasContext = url.searchParams.get("hasContext");

    if (url.searchParams.get("hasEmbedding") === "false") {
      return { nextCursor: undefined, totalCount: 1, tracks: [capturedFinding] };
    }

    if (url.searchParams.get("hasVideo") === "true") {
      return { nextCursor: undefined, totalCount: 1, tracks: [videoedFinding] };
    }

    if (paginateCatalogue && hasContext === null && url.searchParams.get("hasKey") === null) {
      const cursor = url.searchParams.get("cursor");
      return cursor
        ? { nextCursor: undefined, totalCount: 2, tracks: [finding("track_page2", "002.1.2")] }
        : { nextCursor: "page2", totalCount: 2, tracks: [finding("track_page1", "002.1.1")] };
    }

    const tracks =
      hasContext === "true"
        ? [contextedFinding]
        : [contextedFinding, finding("track_no_context", "001.1.2")];

    return { nextCursor: undefined, totalCount: tracks.length, tracks };
  },
}));

const {
  contextQueueCommand,
  embedQueueCommand,
  listCommand,
  noteQueueCommand,
  queueCommand,
  vehiclesCommand,
} = await import("./admin-tracks");
const { mapTrack } = await import("./recent");

describe("context queue — --retry-empty plumbing", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("the routine queue read omits retryEmptyContext (narrow sweep)", async () => {
    await contextQueueCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");

    expect(url.searchParams.get("hasContext")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.has("retryEmptyContext")).toBe(false);
  });

  test("--retry-empty widens the read with retryEmptyContext=true", async () => {
    await contextQueueCommand(10, true);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");

    expect(url.searchParams.get("hasContext")).toBe("false");
    expect(url.searchParams.get("retryEmptyContext")).toBe("true");
  });
});

describe("vehicles ledger — the diversity read the axis assigner consumes", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("reads the has-video ledger and carries every axis, palette included", async () => {
    const ledger = await vehiclesCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");
    expect(url.searchParams.get("hasVideo")).toBe("true");
    expect(url.searchParams.get("order")).toBe("desc");

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      grain: "grainCoarseSilver",
      logId: "003.3.3",
      palette: "amber-warm",
      register: "representational",
      vehicle: "derelict hull",
    });
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

    expect(url.searchParams.get("hasContext")).toBe("true");
    expect(url.searchParams.get("hasNote")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
  });
});

describe("tracks list — Rekordbox-sync backlog filter", () => {
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

    const logIds = tracks.map((track) => track.logId);
    expect(logIds).toContain("001.1.1");
    expect(logIds).not.toContain("001.1.2");
  });
});

describe("embed queue — carries the private capture key through to the box", () => {
  beforeEach(() => {
    requestedPaths = [];
  });

  test("requests the hasEmbedding=false worklist, oldest first", async () => {
    await embedQueueCommand(10);

    expect(requestedPaths).toHaveLength(1);
    const url = new URL(requestedPaths[0] ?? "", "https://fluncle.test");

    expect(url.searchParams.get("hasEmbedding")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  test("retains sourceAudioKey so the on-box sweep can fetch the full song", async () => {
    const tracks = await embedQueueCommand(10);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.sourceAudioKey).toBe("004.6.0Q/deadbeef.m4a");
  });
});

describe("mapTrack — faithful sourceAudioKey passthrough", () => {
  test("preserves the key when the admin path supplies it", () => {
    const mapped = mapTrack(capturedFinding);

    expect(mapped.type).toBe("finding");
    expect((mapped as TrackListItem).sourceAudioKey).toBe("004.6.0Q/deadbeef.m4a");
  });

  test("yields no key when the public path already stripped it (never invents one)", () => {
    const mapped = mapTrack(finding("track_public", "005.1.1"));

    expect((mapped as TrackListItem).sourceAudioKey).toBeUndefined();
  });

  test("preserves analyzedAt — the same whitelist-drop class that hid the analysis timestamp", () => {
    const stamped: TrackListItem = {
      ...finding("track_stamped", "006.1.1"),
      analyzedAt: "2026-07-10T06:39:51.632Z",
      analyzedFrom: "full",
    };
    const mapped = mapTrack(stamped);

    expect((mapped as TrackListItem).analyzedAt).toBe("2026-07-10T06:39:51.632Z");
    expect((mapped as TrackListItem).analyzedFrom).toBe("full");
  });

  test("loses NO field — passthrough, not a whitelist (fails if a re-projection returns)", () => {
    const rich: Record<string, unknown> = {
      ...finding("track_rich", "007.2.2"),
      analyzedAt: "2026-07-10T06:39:51.632Z",
      analyzedFrom: "full",
      bpmSource: "audio-file",
      discogsReleaseUrl: "https://discogs.example/1",
      keySource: "rekordbox",
      logPageUrl: "https://www.fluncle.com/log/007.2.2",
      sourceAudioKey: "007.2.2/cafebabe.m4a",
      updatedAt: "2026-07-10T07:00:00.000Z",
      youtubeUrl: "https://youtu.be/abc",
    };
    const mapped = mapTrack(rich as unknown as TrackListItem) as unknown as Record<string, unknown>;

    expect(Object.keys(mapped).sort()).toEqual(Object.keys(rich).sort());
    for (const key of Object.keys(rich)) {
      expect(mapped[key]).toEqual(rich[key]);
    }
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

    expect(requestedPaths).toHaveLength(2);
    const secondUrl = new URL(requestedPaths[1] ?? "", "https://fluncle.test");
    expect(secondUrl.searchParams.get("cursor")).toBe("page2");

    const logIds = tracks.map((track) => track.logId);
    expect(logIds).toContain("002.1.1");
    expect(logIds).toContain("002.1.2");
  });

  test("a finite limit stops after the first page", async () => {
    const tracks = await listCommand({ limit: 1, order: "desc" });

    expect(requestedPaths).toHaveLength(1);
    expect(tracks).toHaveLength(1);
  });
});
