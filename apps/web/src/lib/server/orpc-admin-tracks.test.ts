import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, readJson, setAdminTokenEnv } from "./orpc-test-kit";

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
const renderObservationCartesia = vi.fn();
const fetchTrackContext = vi.fn();
const presignUploads = vi.fn();
const listTracks = vi.fn();
const searchTracks = vi.fn();
const publishTrack = vi.fn();
const recordNoteAttempt = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: { VIDEOS: { put: (...args: unknown[]) => put(...args) } },
}));

vi.mock("./track-update", () => ({
  updateTrack: (...args: unknown[]) => updateTrack(...args),
}));

vi.mock("./backfill", () => ({
  recordNoteAttempt: (...args: unknown[]) => recordNoteAttempt(...args),
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

vi.mock("./r2-presign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./r2-presign")>();

  return {
    ...actual,
    presignUploads: (...args: unknown[]) => presignUploads(...args),
  };
});

vi.mock("./observation", async (importOriginal) => {
  // Keep the REAL voice gate (gateObservationScript) + defaults; fake only the
  // vendor I/O (firecrawl + Cartesia).
  const actual = await importOriginal<typeof import("./observation")>();

  return {
    ...actual,
    fetchTrackContext: (query: string) => fetchTrackContext(query),
    renderObservationCartesia: (...args: unknown[]) => renderObservationCartesia(...args),
    resolveCartesiaVoiceId: async (override?: string) => override ?? "voice-stock-1",
  };
});

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

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  updateTrack.mockReset();
  getTrackByIdOrLogId.mockReset();
  getTrackContextNote.mockReset().mockResolvedValue(null);
  put.mockReset();
  fetchTrackContext.mockReset();
  presignUploads.mockReset();
  renderObservationCartesia
    .mockReset()
    .mockResolvedValue({ bytes: new ArrayBuffer(512), voiceId: "voice-stock-1" });
  fetchTrackContext.mockResolvedValue({
    contextNote: "Signature Records, 2008.",
    distilled: true,
    sources: [],
    status: "resolved",
  });
  listTracks.mockReset();
  searchTracks.mockReset();
  publishTrack.mockReset();
  recordNoteAttempt.mockReset().mockResolvedValue(undefined);
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
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      { bpm: 174, key: "F minor" },
      { writer: "operator" },
    );
  });

  it("lets the operator write an operator-only field (note)", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { note: "A tight take." }));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      { note: "A tight take." },
      { writer: "operator" },
    );
  });

  it('clears the note on `note: ""` (the regression — write, don\'t no-op)', async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(patch(OPERATOR_TOKEN, { note: "" }));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: "" }, { writer: "operator" });
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
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      {
        bpm: 174,
        enrichmentStatus: "done",
        key: "F minor",
      },
      { writer: "agent" },
    );
  });

  // ── the full-song capture write-back (RFC full-audio § Unit 1) ────────────
  it("lets the AGENT write the capture fields (analysis, NOT operator-only)", async () => {
    updateTrack.mockResolvedValueOnce({
      fields: ["capture_status", "source_audio_key", "source_audio_captured_at"],
      trackId: TRACK_ID,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, {
        captureStatus: "done",
        sourceAudioCapturedAt: "2026-07-07T12:00:00.000Z",
        sourceAudioKey: "004.7.2I/abc123.opus",
      }),
    );

    expect(response?.status).toBe(200);
    // Capture fields are agent-writable machine analysis — the box cron authenticates
    // with the AGENT token, so they must NOT be in OPERATOR_ONLY_FIELDS (no 403).
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      {
        captureStatus: "done",
        sourceAudioCapturedAt: "2026-07-07T12:00:00.000Z",
        sourceAudioKey: "004.7.2I/abc123.opus",
      },
      { writer: "agent" },
    );
  });

  it("lets the AGENT record a capture FAILURE (status + attempt stamp + failure count)", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["capture_status"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, {
        captureStatus: "failed",
        sourceAudioAttemptedAt: "2026-07-07T12:00:00.000Z",
        sourceAudioFailures: 2,
      }),
    );

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      {
        captureStatus: "failed",
        sourceAudioAttemptedAt: "2026-07-07T12:00:00.000Z",
        sourceAudioFailures: 2,
      },
      { writer: "agent" },
    );
  });

  it("the AGENT may pair a done capture with the clobber-safe enrichment re-queue", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["capture_status"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, {
        captureStatus: "done",
        enrichmentStatus: "pending",
        sourceAudioKey: "004.7.2I/abc123.opus",
      }),
    );

    // enrichmentStatus is already an agent-writable analysis field, so the mixed
    // capture + re-queue payload passes the field guard wholesale.
    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      {
        captureStatus: "done",
        enrichmentStatus: "pending",
        sourceAudioKey: "004.7.2I/abc123.opus",
      },
      { writer: "agent" },
    );
  });

  it("drops an invalid captureStatus (not one of the 4 enum values) rather than storing it", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["source_audio_key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, {
        captureStatus: "bogus",
        sourceAudioKey: "004.7.2I/abc123.opus",
      }),
    );

    expect(response?.status).toBe(200);
    // The bad enum value never reaches updateTrack; the valid key still writes.
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect("captureStatus" in update).toBe(false);
    expect(update.sourceAudioKey).toBe("004.7.2I/abc123.opus");
  });

  it.each([
    ["note", { note: "an editorial take" }],
    ["videoUrl", { videoUrl: "https://r2/footage.mp4" }],
    ["logId", { logId: "F-0001" }],
    ["isrc", { isrc: "GB-XXX-00-00000" }],
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

  // The provenance guard's tier MUST come from the authenticated context, never the
  // body: a body claiming `writer: "operator"` cannot let an agent's DSP key clobber a
  // rekordbox value. The handler threads `context.role`; a stray body field is dropped.
  it("threads the AUTHENTICATED tier to updateTrack, ignoring a body-supplied writer", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, { key: "F minor", writer: "operator" } as Record<string, unknown>),
    );

    expect(response?.status).toBe(200);
    // The agent token → `{ writer: "agent" }`, and the stray body `writer` never rides
    // into the update object updateTrack receives.
    const [, update, options] = updateTrack.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ writer: "agent" });
    expect("writer" in update).toBe(false);
  });
});

// ── observe_track — agent tier (FLIPPED from operator; Build order #3) ────────
describe("oRPC observe_track (POST /admin/tracks/{trackId}/observe)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/observe", undefined, { script: GOOD_SCRIPT }));

    expect(response?.status).toBe(401);
    expect(renderObservationCartesia).not.toHaveBeenCalled();
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
    expect(renderObservationCartesia).toHaveBeenCalled();
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
    // No stored context note → observe_track freshly fetches it and backfills it,
    // marking context_status=resolved so the status-aware queue treats it as done.
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      contextNote: "Signature Records, 2008.",
      contextStatus: "resolved",
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationDurationMs: 28000,
      observationGeneratedAt: expect.any(String),
      observationScript: GOOD_SCRIPT,
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
    expect(renderObservationCartesia).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("force: re-renders an existing observation (bypasses idempotency)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({
      ...TRACK,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1",
      observationDurationMs: 30000,
      observationGeneratedAt: "2026-06-01T00:00:00.000Z",
    });
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", OPERATOR_TOKEN, { force: true, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { ok: boolean; skipped?: boolean };
    expect(data.ok).toBe(true);
    expect(data.skipped).toBeUndefined();
    // The whole render path runs again — the deliberate operator re-render.
    expect(renderObservationCartesia).toHaveBeenCalled();
    expect(updateTrack).toHaveBeenCalled();
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
    expect(renderObservationCartesia).not.toHaveBeenCalled();
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
    expect(renderObservationCartesia).not.toHaveBeenCalled();
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
      distilled: true,
      sources: ["https://signature.example/release"],
      status: "resolved",
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
    // It writes the distilled note + the resolved status — both internal, no
    // observation/render/R2 side effects. The quiet-write (no updated_at bump) is
    // track-update.ts's responsibility; here we prove the handler touches nothing
    // but the note + its reliability marker.
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      contextNote: "Signature Records, 2008.",
      contextStatus: "resolved",
    });
    expect(renderObservationCartesia).not.toHaveBeenCalled();
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

  it("marks context_status=empty on an empty Firecrawl result (no note, queue skips it)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce(null);
    fetchTrackContext.mockResolvedValueOnce({
      contextNote: "",
      distilled: false,
      sources: [],
      status: "empty",
    });
    updateTrack.mockResolvedValueOnce({ fields: ["context_status"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    // A confirmed-empty fetch writes the reliability marker (NOT the note) so the
    // status-aware queue stops re-burning Firecrawl + the distil LLM on it every tick
    // (only `--retry-empty` re-picks it). No contextNote in the write.
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { contextStatus: "empty" });
    const update = updateTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("contextNote" in update).toBe(false);
  });

  it("marks context_status=failed on a Firecrawl vendor error (retryable next tick)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce(null);
    fetchTrackContext.mockResolvedValueOnce({
      contextNote: "",
      distilled: false,
      sources: [],
      status: "failed",
    });
    updateTrack.mockResolvedValueOnce({ fields: ["context_status"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { contextStatus: "failed" });
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

  // ── context_track --refresh: re-run even when a note already exists ────────
  it("--refresh re-runs the fetch on an already-noted finding (no short-circuit)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce("An old, thin note.");
    fetchTrackContext.mockResolvedValueOnce({
      contextNote: "Signature Records, 2008 — sharper now.",
      distilled: true,
      sources: ["https://signature.example/release"],
      status: "resolved",
    });
    updateTrack.mockResolvedValueOnce({ fields: ["context_note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, { refresh: true }));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { contextNote: string; skipped?: boolean };
    // It did NOT short-circuit: a fresh fetch ran and the sharper note was written.
    expect(data.skipped).toBeUndefined();
    expect(data.contextNote).toBe("Signature Records, 2008 — sharper now.");
    expect(fetchTrackContext).toHaveBeenCalled();
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      contextNote: "Signature Records, 2008 — sharper now.",
      contextStatus: "resolved",
    });
  });

  it("--refresh that re-fetches nothing keeps the existing note (no downgrade)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce("A perfectly good existing note.");
    fetchTrackContext.mockResolvedValueOnce({
      contextNote: "",
      distilled: false,
      sources: [],
      status: "empty",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, { refresh: true }));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { contextNote: string };
    // The empty re-fetch must NOT blank a resolved finding's status or note: no write,
    // and the response reports the PRESERVED note (not the empty fetch).
    expect(updateTrack).not.toHaveBeenCalled();
    expect(data.contextNote).toBe("A perfectly good existing note.");
  });

  it("without --refresh an already-noted finding still short-circuits (default unchanged)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    getTrackContextNote.mockResolvedValueOnce("Already fetched facts.");

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/context", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(((await readJson(response)) as { skipped?: boolean }).skipped).toBe(true);
    expect(fetchTrackContext).not.toHaveBeenCalled();
  });
});

// ── note_track — agent tier (the auto-note authoring step; the written-note
//    sibling of observe_track). The cardinal safety: fill an EMPTY note only. ──
describe("oRPC note_track (POST /admin/tracks/{trackId}/note)", () => {
  // A gate-clean editorial note: dry, no exclamation marks, no banned identity
  // words, no earthly geography, no "we"-as-company. Over the 24-char floor.
  const GOOD_NOTE = "Pure rolling menace, half-step and patient. That is why it is here.";

  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", undefined, { note: GOOD_NOTE }));

    expect(response?.status).toBe(401);
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("lets the AGENT author + store the note on an EMPTY-note finding", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK); // TRACK has no `note` → empty
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { note: string; ok: boolean; skipped?: boolean };
    expect(data.ok).toBe(true);
    expect(data.skipped).toBeUndefined();
    expect(data.note).toBe(GOOD_NOTE);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: GOOD_NOTE });
    // A fill stamps the "ran" state as done (filled = true).
    expect(recordNoteAttempt).toHaveBeenCalledWith(TRACK_ID, true);
  });

  // THE CARDINAL SAFETY GUARANTEE: an operator-written note is NEVER clobbered.
  it("NEVER overwrites an existing operator note — it is a skipped no-op", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({
      ...TRACK,
      note: "The operator's own hand-written note.",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/note", AGENT_TOKEN, { note: "A DIFFERENT auto-authored note that must not land." }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { note: string; ok: boolean; skipped?: boolean };
    expect(data.skipped).toBe(true);
    // The response echoes the PRESERVED operator note, never the agent's payload.
    expect(data.note).toBe("The operator's own hand-written note.");
    // CRITICAL: no write to the note field at all — the operator override wins.
    expect(updateTrack).not.toHaveBeenCalled();
    // The workflow still "ran" (so the board stops re-queueing it), but did NOT fill.
    expect(recordNoteAttempt).toHaveBeenCalledWith(TRACK_ID, false);
  });

  it("treats a whitespace-only stored note as empty and fills it", async () => {
    // toTrackListItem trims a whitespace note to undefined, so the guard sees it as
    // empty and the fill proceeds — the same empty-string semantics the queue uses.
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, note: undefined });
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: GOOD_NOTE });
  });

  it("422s a note with a banned identity word before storing (the voice gate)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/note", AGENT_TOKEN, {
        note: "A clean transmission of rolling menace. That is why it is here.",
      }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("voice_gate");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("422s a note with earthly geography (the cosmos replaces the map)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/note", AGENT_TOKEN, {
        note: "A proper British roller, all menace and patience. That is why it is here.",
      }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("voice_gate");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("422s a note with an exclamation mark (the Dry Rule)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/note", AGENT_TOKEN, { note: "Pure rolling menace, half-step and patient. Banger!" }),
    );

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("voice_gate");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("400s `no_note` for a missing note body", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, {}));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_note");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("422s `note_too_long` over the public budget", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: "a ".repeat(200) }));

    expect(response?.status).toBe(422);
    expect(((await readJson(response)) as { code: string }).code).toBe("note_too_long");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("400s `no_log_id` for a track with no Log ID", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, logId: undefined });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_log_id");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("not_found");
    expect(updateTrack).not.toHaveBeenCalled();
  });
});

// ── presign_track_video_uploads — agent tier ────────────────────────────────
describe("oRPC presign_track_video_uploads (POST .../video/uploads)", () => {
  it("accepts the AGENT (agent tier — the box publishes its own renders)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    presignUploads.mockResolvedValueOnce([
      { contentType: "video/mp4", key: "004.7.2I/footage.mp4", url: "https://r2/put?sig=1" },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/uploads", AGENT_TOKEN, { fields: ["footage"] }));

    expect(response?.status).toBe(200);
    expect(presignUploads).toHaveBeenCalled();
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

  it("signs a PLATES-ONLY set without footage (the plate-lane pre-upload)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    presignUploads.mockResolvedValueOnce([
      { contentType: "image/png", key: "004.7.2I/plate.png", url: "https://r2/put?sig=p" },
      {
        contentType: "image/png",
        key: "004.7.2I/plate.background.png",
        url: "https://r2/put?sig=b",
      },
    ]);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/uploads", AGENT_TOKEN, { fields: ["plate", "plate-background"] }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      logId: "004.7.2I",
      ok: true,
      trackId: TRACK_ID,
      uploads: [
        {
          contentType: "image/png",
          field: "plate",
          key: "004.7.2I/plate.png",
          url: "https://r2/put?sig=p",
        },
        {
          contentType: "image/png",
          field: "plate-background",
          key: "004.7.2I/plate.background.png",
          url: "https://r2/put?sig=b",
        },
      ],
    });
  });

  it("a plate MIXED with a non-plate footage-less field still 400s `no_footage`", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/uploads", OPERATOR_TOKEN, { fields: ["plate", "cover"] }),
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

// ── finalize_track_video — agent tier ───────────────────────────────────────
describe("oRPC finalize_track_video (POST .../video/finalize)", () => {
  it("accepts the AGENT (agent tier — the box publishes its own renders)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/finalize", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalled();
  });

  it("links the canonical cut and returns the live envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/finalize", OPERATOR_TOKEN, {
        squared: true,
        videoGrain: "grainCoarseSilver",
        videoRegister: "abstract",
        videoVehicle: "submarine",
      }),
    );

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { logId: string; ok: boolean; videoUrl: string };
    expect(data.ok).toBe(true);
    expect(data.logId).toBe("004.7.2I");
    expect(data.videoUrl).toContain("004.7.2I");

    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBe("submarine");
    expect(update.videoGrain).toBe("grainCoarseSilver");
    expect(update.videoRegister).toBe("abstract");
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

// ── requeue_video — operator tier (clear the video to re-queue a re-render) ──
// A finding WITH a live video: both the render-queue gate (videoUrl) and the
// radio gate (videoSquaredAt) are set, so a requeue must clear BOTH.
const FILMED_TRACK = {
  ...TRACK,
  videoSquaredAt: "2026-06-01T00:00:00.000Z",
  videoUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
};

describe("oRPC requeue_video (POST .../video/requeue)", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", undefined, {}));

    expect(response?.status).toBe(401);
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("403s the AGENT (operator-only — the box agent never clears a live video)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", AGENT_TOKEN, {}));

    expect(response?.status).toBe(403);
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("clears BOTH video_url and video_squared_at for the operator", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(FILMED_TRACK);
    updateTrack.mockResolvedValueOnce({
      fields: ["video_squared_at", "video_url"],
      trackId: TRACK_ID,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", OPERATOR_TOKEN, {}));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as {
      alreadyClear?: boolean;
      logId: string;
      ok: boolean;
      trackId: string;
    };
    expect(data.ok).toBe(true);
    expect(data.logId).toBe("004.7.2I");
    expect(data.trackId).toBe(TRACK_ID);
    // A real clear, not a no-op.
    expect(data.alreadyClear).toBeUndefined();
    // Empty string is the updateTrack contract for "clear to NULL" on both gates —
    // and ONLY those two (the vehicle/grain/model ledger is left intact).
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { videoSquaredAt: "", videoUrl: "" });
  });

  it("is idempotent: an already-clear finding is a no-op (alreadyClear, no write)", async () => {
    // TRACK has neither videoUrl nor videoSquaredAt → already at "no video" state.
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", OPERATOR_TOKEN, {}));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { alreadyClear?: boolean; ok: boolean };
    expect(data.ok).toBe(true);
    expect(data.alreadyClear).toBe(true);
    // Clean no-op: no write, no cache purge.
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("400s `no_log_id` for a track with no Log ID", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...FILMED_TRACK, logId: undefined });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", OPERATOR_TOKEN, {}));

    expect(response?.status).toBe(400);
    expect(((await readJson(response)) as { code: string }).code).toBe("no_log_id");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", OPERATOR_TOKEN, {}));

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

  it("parses the auto-note queue filter (hasContext=true AND hasNote=false)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?hasContext=true&hasNote=false", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasContext).toBe(true);
    expect(opts.hasNote).toBe(false);
  });

  it("parses the Rekordbox-sync queue filter (hasKey=false)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?hasKey=false&order=asc", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasKey).toBe(false);
  });

  it("parses the capture queue filter (captureQueue=true, newest-first)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?captureQueue=true&order=desc", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.captureQueue).toBe(true);
    expect(opts.order).toBe("desc");
  });

  it("CARRIES sourceAudioKey through the admin capture-queue read (the sweeps need it)", async () => {
    const captured = { ...LIST_ITEM, sourceAudioKey: "004.7.2I/abc123.m4a" };
    listTracks.mockResolvedValueOnce({ totalCount: 1, tracks: [captured] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?captureQueue=true&order=desc", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const body = (await readJson(response)) as { tracks: Array<{ sourceAudioKey?: string }> };
    // The admin read is the on-box sweep's source of truth — the private key MUST survive
    // here (only the PUBLIC reads strip it).
    expect(body.tracks[0]?.sourceAudioKey).toBe("004.7.2I/abc123.m4a");
  });

  it("leaves captureQueue false when absent (a separate, opt-in queue)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?hasEmbedding=false", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    // The embed queue read must never carry a capture predicate — capture never gates it.
    expect(opts.captureQueue).toBe(false);
    expect(opts.hasEmbedding).toBe(false);
  });

  it("leaves the new filters undefined when absent (tri-state)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];
    expect(opts.hasContext).toBeUndefined();
    expect(opts.hasKey).toBeUndefined();
    expect(opts.hasNote).toBeUndefined();
    expect(opts.hasObservation).toBeUndefined();
  });
});

// ── get_track_admin — admin tier (the single-finding by-coordinate lookup) ───
function getOne(id: string, token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/${encodeURIComponent(id)}`, {
    headers,
  });
}

describe("oRPC get_track_admin (GET /admin/tracks/{trackId})", () => {
  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(getOne(TRACK_ID, undefined));

    expect(response?.status).toBe(401);
    expect(getTrackByIdOrLogId).not.toHaveBeenCalled();
  });

  it("lets the AGENT read one finding and returns the full admin envelope", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(LIST_ITEM);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(getOne(TRACK_ID, AGENT_TOKEN));

    expect(response?.status).toBe(200);
    // The authoritative single read: the real finding resolves in full (the incident
    // was a live finding misread as nonexistent). The lookup accepts an id OR a Log ID.
    expect(await readJson(response)).toEqual({ ok: true, track: LIST_ITEM });
    expect(getTrackByIdOrLogId).toHaveBeenCalledWith(TRACK_ID);
  });

  it("resolves by Log ID too (not just the Spotify trackId)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(LIST_ITEM);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(getOne("004.7.2I", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(getTrackByIdOrLogId).toHaveBeenCalledWith("004.7.2I");
  });

  it("404s `not_found` for a genuinely missing coordinate (distinct from auth/validation)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(getOne("000.0.0X", AGENT_TOKEN));

    expect(response?.status).toBe(404);
    const body = (await readJson(response)) as { code: string; message: string };
    // The canonical not_found — a distinct code the caller can trust means "no such
    // finding", never confused with a 401/403 auth failure or a malformed request.
    expect(body.code).toBe("not_found");
    expect(body.message).toBe("No track with id 000.0.0X");
  });
});

// ── publish_track — operator tier (publish from a Spotify URL) ───────────────
describe("oRPC publish_track (POST /admin/tracks)", () => {
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

  it("publishes for the operator and returns the live envelope (no on-add enrichment push)", async () => {
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
    // No on-add enrichment push: the add leaves the new finding at the schema
    // default `enrichment_status = "pending"` (queue-eligible), and the on-box
    // `fluncle-enrich` cron drains it. The handler must NOT write the status
    // itself — `updateTrack` is the cron's write-back, never the add path.
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("does not touch enrichment state on a dry run either", async () => {
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
    expect(updateTrack).not.toHaveBeenCalled();
  });
});
