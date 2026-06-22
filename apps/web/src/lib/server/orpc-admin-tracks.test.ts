import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "./orpc-test-helpers";

// The ADMIN wave's pilot parity + auth proof: the `admin-tracks` ops driven
// end-to-end through `handleOrpc` against `/api/v1/admin/...`, so the REAL admin
// auth spine (../orpc-auth: `adminAuth` / `operatorGuard`) runs — only the
// data-layer helpers (Turso, R2, the observation vendors, the presigner) are
// mocked. This is the security-critical half of the wave: the FIELD-LEVEL role
// guard on `update_track`, and the procedure-tier 401/403 on every op, must
// reproduce the live route behavior byte-for-byte.
//
//   - update_track (PATCH /admin/tracks/{trackId}) — on `adminAuth`: BOTH the
//     operator and the agent authenticate, then the in-handler guard bounds the
//     agent to analysis fields (an operator-only field = 403 `forbidden`, the db
//     untouched). The operator may write anything. 401 without a token.
//   - observe_track / presign_track_video_uploads / finalize_track_video — on the
//     operator tier (live `requireOperator`): the agent gets a 403 `forbidden`, a
//     non-admin a 401, the operator passes.

const updateTrack = vi.fn();
const getTrackByIdOrLogId = vi.fn();
const getTrackContextNote = vi.fn();
const put = vi.fn();
const renderObservation = vi.fn();
const fetchTrackContext = vi.fn();
const presignUploads = vi.fn();
const listTracks = vi.fn();
const searchTracks = vi.fn();
const publishTrack = vi.fn();
const triggerEnrichment = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: { VIDEOS: { put: (...args: unknown[]) => put(...args) } },
}));

vi.mock("./track-update", () => ({
  updateTrack: (...args: unknown[]) => updateTrack(...args),
}));

vi.mock("./tracks", async (importOriginal) => {
  // Keep the REAL cursor decoder + the enrichment-status filter set (the admin
  // board's parse logic uses them); fake only the DB reads.
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getTrackByIdOrLogId: (id: string) => getTrackByIdOrLogId(id),
    getTrackContextNote: (id: string) => getTrackContextNote(id),
    listTracks: (...args: unknown[]) => listTracks(...args),
    searchTracks: (...args: unknown[]) => searchTracks(...args),
  };
});

vi.mock("./publish", () => ({
  publishTrack: (...args: unknown[]) => publishTrack(...args),
}));

vi.mock("./spinup", () => ({
  triggerEnrichment: (...args: unknown[]) => triggerEnrichment(...args),
}));

vi.mock("./r2-presign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./r2-presign")>();

  return {
    ...actual,
    presignUploads: (...args: unknown[]) => presignUploads(...args),
  };
});

vi.mock("./observation", async (importOriginal) => {
  // Keep the REAL voice gate (gateObservationScript) + defaults; fake only the
  // vendor I/O (firecrawl + ElevenLabs).
  const actual = await importOriginal<typeof import("./observation")>();

  return {
    ...actual,
    fetchTrackContext: (query: string) => fetchTrackContext(query),
    renderObservation: (...args: unknown[]) => renderObservation(...args),
    resolveVoiceId: async (override?: string) => override ?? "voice-stock-1",
  };
});

const OPERATOR_TOKEN = "test-token-admin-operator";
const AGENT_TOKEN = "test-token-admin-agent";
const TRACK_ID = "track-123";

const TRACK = {
  artists: ["Calibre"],
  label: "Signature",
  logId: "004.7.2I",
  releaseDate: "2008",
  title: "Mr Right On",
  trackId: TRACK_ID,
};

const GOOD_SCRIPT =
  "Arrived on the dark side of the sector and this one moved at a hard, even pace. Knees went up before I clocked the coordinate. Logged it as fluncle://004.7.2I. Hope it gets an oof out of you, fam.";

// A schema-complete `TrackListItem` for the list/search output (oRPC validates the
// response body against the contract, so a partial row would 500).
const LIST_ITEM = {
  addedAt: "2026-06-01T00:00:00.000Z",
  addedToSpotify: true,
  artists: ["Calibre"],
  durationMs: 300000,
  enrichmentStatus: "done",
  postedToTelegram: true,
  spotifyUrl: "https://open.spotify.com/track/x",
  title: "Mr Right On",
  trackId: TRACK_ID,
};

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = OPERATOR_TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

beforeEach(() => {
  updateTrack.mockReset();
  getTrackByIdOrLogId.mockReset();
  getTrackContextNote.mockReset().mockResolvedValue(null);
  put.mockReset();
  fetchTrackContext.mockReset();
  presignUploads.mockReset();
  renderObservation
    .mockReset()
    .mockResolvedValue({ bytes: new ArrayBuffer(512), voiceId: "voice-stock-1" });
  fetchTrackContext.mockResolvedValue({ contextNote: "Signature Records, 2008.", sources: [] });
  listTracks.mockReset();
  searchTracks.mockReset();
  publishTrack.mockReset();
  triggerEnrichment.mockReset();
});

function patch(token: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/${TRACK_ID}`, {
    body: JSON.stringify(body),
    headers,
    method: "PATCH",
  });
}

function post(path: string, token: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/${TRACK_ID}${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

// ── update_track — the field-level role guard ───────────────────────────────
describe("oRPC update_track (PATCH /admin/tracks/{trackId})", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(undefined, { bpm: 174 }));

    expect(response?.status).toBe(401);
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("lets the operator write analysis fields and returns the live envelope", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["bpm", "key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { bpm: 174, key: "F minor" }));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      fields: ["bpm", "key"],
      ok: true,
      trackId: TRACK_ID,
    });
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { bpm: 174, key: "F minor" });
  });

  it("lets the operator write an operator-only field (note)", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { note: "A tight take." }));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: "A tight take." });
  });

  it('clears the note on `note: ""` (the regression — write, don\'t no-op)', async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { note: "" }));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: "" });
  });

  it("422s a note over the budget with the live `note_too_long` code", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { note: "x".repeat(281) }));

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("note_too_long");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("lets the AGENT write analysis fields", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["bpm", "key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, { bpm: 174, enrichmentStatus: "done", key: "F minor" }),
    );

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      bpm: 174,
      enrichmentStatus: "done",
      key: "F minor",
    });
  });

  it.each([
    ["note", { note: "an editorial take" }],
    ["vibeX", { vibeX: 0.5 }],
    ["videoUrl", { videoUrl: "https://r2/footage.mp4" }],
    ["logId", { logId: "F-0001" }],
    ["isrc", { isrc: "GB-XXX-00-00000" }],
    ["vibeY", { vibeY: 0.5 }],
  ])("403s the AGENT writing %s, db untouched", async (_field, body) => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(AGENT_TOKEN, body));

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("403s the AGENT on a mixed payload (analysis + operator field) wholesale", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(AGENT_TOKEN, { bpm: 174, note: "sneaking a note in" }));

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    expect(updateTrack).not.toHaveBeenCalled();
  });
});

// ── observe_track — agent tier (FLIPPED from operator; Build order #3) ────────
describe("oRPC observe_track (POST /admin/tracks/{trackId}/observe)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/observe", undefined, { script: GOOD_SCRIPT }));

    expect(response?.status).toBe(401);
    expect(renderObservation).not.toHaveBeenCalled();
  });

  it("lets the AGENT observe (the tier flip — no longer operator-only)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", AGENT_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    expect(((await readJson(response)) as { ok: boolean }).ok).toBe(true);
    expect(renderObservation).toHaveBeenCalled();
  });

  it("renders, uploads three R2 objects, writes back, and returns the live envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", OPERATOR_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as {
      audioUrl: string;
      durationMs: number;
      ok: boolean;
    };
    expect(data.ok).toBe(true);
    expect(data.audioUrl).toBe("https://found.fluncle.com/004.7.2I/observation.mp3");
    expect(data.durationMs).toBe(28000);

    expect(put.mock.calls.map((call) => call[0])).toEqual([
      "004.7.2I/observation.mp3",
      "004.7.2I/observation.txt",
      "004.7.2I/observation.json",
    ]);
    // No stored context note → observe_track freshly fetches it and backfills it.
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      contextNote: "Signature Records, 2008.",
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationDurationMs: 28000,
      observationGeneratedAt: expect.any(String),
    });
  });

  it("reads the STORED context note instead of re-fetching Firecrawl", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce("Stored facts: Signature Records, 2008.");
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", AGENT_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    // The stored note short-circuits the fetch entirely.
    expect(fetchTrackContext).not.toHaveBeenCalled();
    // A stored (not freshly fetched) note is NOT re-written.
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect("contextNote" in update).toBe(false);
  });

  it("is idempotent: an existing observation is a no-op (skipped, no render)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({
      ...TRACK,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1",
      observationDurationMs: 30000,
      observationGeneratedAt: "2026-06-01T00:00:00.000Z",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", AGENT_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { ok: boolean; skipped?: boolean };
    expect(data.ok).toBe(true);
    expect(data.skipped).toBe(true);
    // No render, no upload, no write-back — a clean idempotent no-op.
    expect(renderObservation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("422s a script with a banned identity word before spending a render", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", OPERATOR_TOKEN, {
        script:
          "The signal carried a clean pace and the knees went up. Logged it as fluncle://004.7.2I, fam.",
      }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("voice_gate");
    expect(renderObservation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("422s a script with earthly geography leaked from the context note", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", AGENT_TOKEN, {
        script:
          "This one flies the flag for the American side of the map and the knees went up before I clocked the coordinate, fam.",
      }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("voice_gate");
    expect(renderObservation).not.toHaveBeenCalled();
  });

  it("400s `no_log_id` for a track with no Log ID", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, logId: undefined });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/observe", OPERATOR_TOKEN, { script: GOOD_SCRIPT }));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_log_id");
  });
});

// ── context_track — agent tier (the split-out context half; Build order #3) ──
describe("oRPC context_track (POST /admin/tracks/{trackId}/context)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", undefined, {}));

    expect(response?.status).toBe(401);
    expect(fetchTrackContext).not.toHaveBeenCalled();
  });

  it("lets the AGENT fetch facts and writes context_note QUIETLY (no observation)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce(null);
    fetchTrackContext.mockResolvedValueOnce({
      contextNote: "Signature Records, 2008.",
      sources: ["https://signature.example/release"],
    });
    updateTrack.mockResolvedValueOnce({ fields: ["context_note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as {
      contextNote: string;
      ok: boolean;
      sources: string[];
    };
    expect(data.ok).toBe(true);
    expect(data.contextNote).toBe("Signature Records, 2008.");
    expect(data.sources).toEqual(["https://signature.example/release"]);
    // It writes ONLY contextNote — no observation/render/R2 side effects. The
    // quiet-write (no updated_at bump) is track-update.ts's responsibility; here we
    // prove the handler touches nothing but the note.
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { contextNote: "Signature Records, 2008." });
    expect(renderObservation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("is idempotent: an existing context note is a no-op (skipped, no fetch)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce("Already fetched facts.");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { contextNote: string; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.contextNote).toBe("Already fetched facts.");
    expect(fetchTrackContext).not.toHaveBeenCalled();
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("leaves the note null on an empty Firecrawl result (queue re-picks next tick)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce(null);
    fetchTrackContext.mockResolvedValueOnce({ contextNote: "", sources: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    // An empty fetch must NOT write through — the queue (context_note IS NULL) keeps
    // re-picking it rather than locking in an empty note.
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("400s `no_log_id` for a track with no Log ID", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, logId: undefined });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_log_id");
    expect(fetchTrackContext).not.toHaveBeenCalled();
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("not_found");
  });
});

// ── presign_track_video_uploads — operator tier ─────────────────────────────
describe("oRPC presign_track_video_uploads (POST .../video/uploads)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/uploads", AGENT_TOKEN, { fields: ["footage"] }));

    expect(response?.status).toBe(403);
    expect(presignUploads).not.toHaveBeenCalled();
  });

  it("signs the requested fields and returns the live `uploads` envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    presignUploads.mockResolvedValueOnce([
      { contentType: "video/mp4", key: "004.7.2I/footage.mp4", url: "https://r2/put?sig=1" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/uploads", OPERATOR_TOKEN, { fields: ["footage"] }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      logId: "004.7.2I",
      ok: true,
      trackId: TRACK_ID,
      uploads: [
        {
          contentType: "video/mp4",
          field: "footage",
          key: "004.7.2I/footage.mp4",
          url: "https://r2/put?sig=1",
        },
      ],
    });
  });

  it("400s `no_footage` when footage is not among the fields", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/uploads", OPERATOR_TOKEN, { fields: ["cover"] }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_footage");
    expect(presignUploads).not.toHaveBeenCalled();
  });

  it("400s `no_fields` for an empty request", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/uploads", OPERATOR_TOKEN, { fields: [] }));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_fields");
  });
});

// ── finalize_track_video — operator tier ────────────────────────────────────
describe("oRPC finalize_track_video (POST .../video/finalize)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/finalize", AGENT_TOKEN, {}));

    expect(response?.status).toBe(403);
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("links the canonical cut and returns the live envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/finalize", OPERATOR_TOKEN, { squared: true, videoVehicle: "submarine" }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { logId: string; ok: boolean; videoUrl: string };
    expect(data.ok).toBe(true);
    expect(data.logId).toBe("004.7.2I");
    expect(data.videoUrl).toContain("004.7.2I");

    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBe("submarine");
    expect(update.videoModel).toBe("anthropic/claude-opus-4-8");
    expect(update.videoModelReasoning).toBe("high");
    expect(typeof update.videoSquaredAt).toBe("string");
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/finalize", OPERATOR_TOKEN, {}));

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("not_found");
    expect(updateTrack).not.toHaveBeenCalled();
  });
});

// ── list_tracks_admin — admin tier (the board query) ─────────────────────────
function adminGet(query: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks${query}`, { headers });
}

describe("oRPC list_tracks_admin (GET /admin/tracks)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("", undefined));

    expect(response?.status).toBe(401);
    expect(listTracks).not.toHaveBeenCalled();
  });

  it("lets the AGENT read the paginated list page (no `ok` envelope)", async () => {
    listTracks.mockResolvedValueOnce({ nextCursor: "cur", totalCount: 2, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      adminGet("?order=asc&hasVideo=false&status=pending", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ nextCursor: "cur", totalCount: 2, tracks: [] });
    // The filters parsed in-handler (order asc, hasVideo false, status pending).
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.order).toBe("asc");
    expect(opts.hasVideo).toBe(false);
    expect(opts.status).toBe("pending");
    expect(searchTracks).not.toHaveBeenCalled();
  });

  it("takes the `?q=` SEARCH branch and returns the flat `{ tracks }` body", async () => {
    searchTracks.mockResolvedValueOnce([LIST_ITEM]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?q=calibre&limit=5", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ tracks: [LIST_ITEM] });
    expect(searchTracks).toHaveBeenCalledWith({ limit: 5, q: "calibre" });
    expect(listTracks).not.toHaveBeenCalled();
  });

  it("parses the `hasContext=false` context queue filter", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?hasContext=false&order=asc", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasContext).toBe(false);
    expect(opts.hasObservation).toBeUndefined();
  });

  it("parses the observation queue filter (hasContext=true AND hasObservation=false)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      adminGet("?hasContext=true&hasObservation=false", AGENT_TOKEN),
    );

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasContext).toBe(true);
    expect(opts.hasObservation).toBe(false);
  });

  it("leaves the new filters undefined when absent (tri-state)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasContext).toBeUndefined();
    expect(opts.hasObservation).toBeUndefined();
  });
});

// ── add_track — operator tier (publish from a Spotify URL) ───────────────────
describe("oRPC add_track (POST /admin/tracks)", () => {
  it("403s the AGENT (operator-only)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/tracks", {
        body: JSON.stringify({ spotifyUrl: "https://open.spotify.com/track/x" }),
        headers: { Authorization: `Bearer ${AGENT_TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(403);
    expect(publishTrack).not.toHaveBeenCalled();
  });

  it("400s `invalid_request` for a missing Spotify URL", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/tracks", {
        body: JSON.stringify({}),
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("invalid_request");
    expect(publishTrack).not.toHaveBeenCalled();
  });

  it("publishes for the operator, triggers enrichment, returns the live envelope", async () => {
    publishTrack.mockResolvedValueOnce({
      addedToSpotify: true,
      dryRun: false,
      message: "Added",
      postedToTelegram: true,
      track: {
        artists: ["Calibre"],
        durationMs: 300000,
        logId: "004.7.2I",
        spotifyUrl: "https://open.spotify.com/track/x",
        title: "Mr Right On",
        trackId: TRACK_ID,
      },
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/tracks", {
        body: JSON.stringify({ note: "a take", spotifyUrl: "https://open.spotify.com/track/x" }),
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { ok: boolean; addedToSpotify: boolean };
    expect(data.ok).toBe(true);
    expect(data.addedToSpotify).toBe(true);
    expect(publishTrack).toHaveBeenCalledWith("https://open.spotify.com/track/x", {
      dryRun: false,
      note: "a take",
    });
    // A live (non-dry) add with a Log ID kicks off async enrichment.
    expect(triggerEnrichment).toHaveBeenCalledWith(TRACK_ID, "004.7.2I");
  });

  it("does NOT trigger enrichment on a dry run", async () => {
    publishTrack.mockResolvedValueOnce({
      addedToSpotify: false,
      dryRun: true,
      message: "Dry run",
      postedToTelegram: false,
      track: {
        artists: ["Calibre"],
        durationMs: 300000,
        logId: "004.7.2I",
        spotifyUrl: "https://open.spotify.com/track/x",
        title: "Mr Right On",
        trackId: TRACK_ID,
      },
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      new Request("https://www.fluncle.com/api/v1/admin/tracks", {
        body: JSON.stringify({ dryRun: true, spotifyUrl: "https://open.spotify.com/track/x" }),
        headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(200);
    expect(publishTrack).toHaveBeenCalledWith("https://open.spotify.com/track/x", {
      dryRun: true,
      note: undefined,
    });
    expect(triggerEnrichment).not.toHaveBeenCalled();
  });
});
