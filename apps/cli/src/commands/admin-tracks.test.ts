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

// A shipped-video finding carrying the full diversity ledger, incl. the palette axis —
// the shape `fluncle admin tracks vehicles --json` reads for the axis assigner.
const videoedFinding: TrackListItem = {
  ...finding("track_videoed", "003.3.3"),
  videoGrain: "grainCoarseSilver",
  videoPalette: "amber-warm",
  videoRegister: "representational",
  videoUrl: "https://found.fluncle.com/003.3.3/footage.mp4",
  videoVehicle: "derelict hull",
};

// A captured finding exactly as the ADMIN embed queue returns it: the private full-song
// capture key is PRESENT (the admin read path never strips it — only public reads run
// through `toPublicTrackListItem`). The on-box embed sweep reads this key to S3-GET the
// full song, so it must survive `mapTrack` on the way to `embed --queue --json`.
const capturedFinding: TrackListItem = {
  ...finding("track_captured", "004.6.0Q"),
  sourceAudioKey: "004.6.0Q/deadbeef.m4a",
};

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

    // The embed worklist (server gate: `embedding_json IS NULL AND source_audio_key IS NOT
    // NULL`). The admin path does NOT strip the key, so the returned row carries it — the
    // exact shape the box embed sweep consumes.
    if (url.searchParams.get("hasEmbedding") === "false") {
      return { nextCursor: undefined, totalCount: 1, tracks: [capturedFinding] };
    }

    // The vehicles ledger read: `video_url is not null`, newest first.
    if (url.searchParams.get("hasVideo") === "true") {
      return { nextCursor: undefined, totalCount: 1, tracks: [videoedFinding] };
    }

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
    // The note cron's worklist: findings with the context_note fuel on file but no
    // editorial note yet — the exact pairing observe uses, swapping hasObservation
    // for hasNote.
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

    // The note-less finding never reaches the render queue: the gate makes the
    // request carry `hasContext=true`, so the server's `context_note is not null`
    // filter drops it. Only the context'd finding survives.
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
    // The embed cron's worklist: findings with no MuQ vector yet. The server ANDs in
    // `source_audio_key IS NOT NULL`, so every row is a captured full song ready to embed.
    expect(url.searchParams.get("hasEmbedding")).toBe("false");
    expect(url.searchParams.get("order")).toBe("asc");
  });

  test("retains sourceAudioKey so the on-box sweep can fetch the full song", async () => {
    const tracks = await embedQueueCommand(10);

    // The regression guard for the exact bug that left the box embedding NOTHING: mapTrack's
    // whitelist dropped sourceAudioKey, so `embed --queue --json` handed the sweep a key-less
    // row and every finding was skipped `no_source_audio`. The admin path must carry it through.
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
    // On `/api/tracks` the server runs `toPublicTrackListItem`, so the key arrives undefined;
    // mapTrack passes that through untouched and JSON.stringify omits it — `fluncle recent`
    // never surfaces the private capture key.
    const mapped = mapTrack(finding("track_public", "005.1.1"));

    expect((mapped as TrackListItem).sourceAudioKey).toBeUndefined();
  });

  test("preserves analyzedAt — the same whitelist-drop class that hid the analysis timestamp", () => {
    // mapTrack's field whitelist carried analyzedFrom but forgot analyzedAt, so `admin tracks
    // list --json` silently reported it as absent on EVERY row while the DB and the single-track
    // GET carried the real value. The admin path must pass both provenance fields through.
    const stamped: TrackListItem = {
      ...finding("track_stamped", "006.1.1"),
      analyzedAt: "2026-07-10T06:39:51.632Z",
      analyzedFrom: "full",
    };
    const mapped = mapTrack(stamped);

    expect((mapped as TrackListItem).analyzedAt).toBe("2026-07-10T06:39:51.632Z");
    expect((mapped as TrackListItem).analyzedFrom).toBe("full");
  });

  // THE STRUCTURAL GUARD. The two tests above are one-off patches for a hole that reopened
  // twice: mapTrack used to re-copy fields from a hand-maintained whitelist, so every new
  // server field was silently dropped until a consumer broke. mapTrack is now a PASSTHROUGH,
  // and this test enforces it — it fails if anyone reintroduces a field-by-field rebuild,
  // no matter WHICH field they forget. Add nothing to mapTrack and this stays green.
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
