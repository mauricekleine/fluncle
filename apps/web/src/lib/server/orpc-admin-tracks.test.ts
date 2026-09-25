import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOKEN,
  OPERATOR_TOKEN,
  readJson,
  setAdminTokenEnv,
  warmOrpcRouter,
} from "./orpc-test-kit";
import { isYoutubeVerification, YOUTUBE_VERIFICATION_VALUES } from "./track-update";

const updateTrack = vi.fn();
const fillEmptyNote = vi.fn();
const pinCaptureSource = vi.fn();
const clearCaptureSource = vi.fn();
const getTrackByIdOrLogId = vi.fn();
const getSimilarFindings = vi.fn();
const getTrackContextNote = vi.fn();
const getObservationProvenance = vi.fn();
const put = vi.fn();

const bucketGet = vi.fn();
const renderObservationCartesia = vi.fn();
const fetchTrackContext = vi.fn();
const presignUploads = vi.fn();
const listTracks = vi.fn();
const searchTracks = vi.fn();
const publishTrack = vi.fn();
const recordNoteAttempt = vi.fn();

const recordNoteRejection = vi.fn();
const getNoteEchoThresholds = vi.fn();
const getObservationEchoThresholds = vi.fn();
const observationNeighbours = vi.fn();
const recordObservationRejection = vi.fn();
const prepareCaptureReconciliation = vi.fn();
const authorizeCaptureReconciliation = vi.fn();
const commitCaptureReconciliation = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: {
    VIDEOS: {
      get: (...args: unknown[]) => bucketGet(...args),
      put: (...args: unknown[]) => put(...args),
    },
  },
}));

vi.mock("./track-update", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./track-update")>();

  return {
    ...actual,
    clearCaptureSource: (...args: unknown[]) => clearCaptureSource(...args),
    fillEmptyNote: (...args: unknown[]) => fillEmptyNote(...args),
    pinCaptureSource: (...args: unknown[]) => pinCaptureSource(...args),
    updateTrack: (...args: unknown[]) => updateTrack(...args),
  };
});

vi.mock("./track-capture-reconciliation", () => ({
  authorizeCaptureReconciliation: (...args: unknown[]) => authorizeCaptureReconciliation(...args),
  commitCaptureReconciliation: (...args: unknown[]) => commitCaptureReconciliation(...args),
  prepareCaptureReconciliation: (...args: unknown[]) => prepareCaptureReconciliation(...args),
}));

vi.mock("./backfill", () => ({
  recordNoteAttempt: (...args: unknown[]) => recordNoteAttempt(...args),
}));

vi.mock("./note-rejections", () => ({
  getNoteEchoThresholds: (...args: unknown[]) => getNoteEchoThresholds(...args),
  recordNoteRejection: (...args: unknown[]) => recordNoteRejection(...args),
}));

vi.mock("./observation-neighbours", () => ({
  observationNeighbours: (...args: unknown[]) => observationNeighbours(...args),
}));

vi.mock("./observation-rejections", () => ({
  getObservationEchoThresholds: (...args: unknown[]) => getObservationEchoThresholds(...args),
  recordObservationRejection: (...args: unknown[]) => recordObservationRejection(...args),
}));

vi.mock("./tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracks")>();

  return {
    ...actual,
    getObservationProvenance: (id: string) => getObservationProvenance(id),
    getSimilarFindings: (...args: unknown[]) => getSimilarFindings(...args),
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

warmOrpcRouter();

beforeEach(() => {
  recordNoteRejection.mockReset();
  recordNoteRejection.mockResolvedValue(undefined);
  getNoteEchoThresholds.mockReset();

  getNoteEchoThresholds.mockResolvedValue({ maxOverlap: 0.3, minPhraseWords: 4 });
  getObservationEchoThresholds
    .mockReset()
    .mockResolvedValue({ maxOverlap: 0.3, minPhraseWords: 4 });
  observationNeighbours.mockReset().mockResolvedValue([]);
  recordObservationRejection.mockReset().mockResolvedValue(undefined);
  updateTrack.mockReset();
  fillEmptyNote.mockReset();
  pinCaptureSource.mockReset();
  clearCaptureSource.mockReset();
  getTrackByIdOrLogId.mockReset();

  getSimilarFindings.mockReset().mockResolvedValue([]);
  getTrackContextNote.mockReset().mockResolvedValue(null);

  getObservationProvenance.mockReset().mockResolvedValue({ promptVersion: null, script: null });
  put.mockReset();

  bucketGet.mockReset().mockResolvedValue(null);
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
  prepareCaptureReconciliation.mockReset();
  authorizeCaptureReconciliation.mockReset();
  commitCaptureReconciliation.mockReset();
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

describe("oRPC capture reconciliation", () => {
  it("requires an admin principal before preparing current state", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/capture/prepare", undefined, {
        kind: "capture",
        trackId: TRACK_ID,
      }),
    );

    expect(response?.status).toBe(401);
    expect(prepareCaptureReconciliation).not.toHaveBeenCalled();
  });

  it("lets the agent prepare, authorize, and receipt-commit one bounded result", async () => {
    prepareCaptureReconciliation.mockResolvedValueOnce({
      prepared: true,
      snapshotToken: "snapshot-token",
      track: {
        artists: ["Calibre"],
        certified: true,
        title: "Even If",
        trackId: TRACK_ID,
      },
    });
    authorizeCaptureReconciliation.mockResolvedValueOnce({
      commitToken: "commit-token",
      operationId: "track.capture",
      operationKey: "track.capture:receipt",
      requestDigest: "a".repeat(64),
    });
    commitCaptureReconciliation.mockResolvedValueOnce({
      outcome: "committed",
      replayed: false,
      result: { applied: true, kind: "capture", outcome: "unmatched" },
    });

    const { handleOrpc } = await import("./orpc");
    const prepared = await handleOrpc(
      post("/capture/prepare", AGENT_TOKEN, { kind: "capture", trackId: TRACK_ID }),
    );
    expect(prepared?.status).toBe(200);
    expect(prepared?.headers.get("Cache-Control")).toBe("no-store");
    expect(prepareCaptureReconciliation).toHaveBeenCalledWith(TRACK_ID, "capture", undefined);

    const authorized = await handleOrpc(
      post("/capture/authorize", AGENT_TOKEN, {
        result: {
          attemptedAt: "2026-09-08T10:00:00.000Z",
          kind: "capture",
          outcome: "unmatched",
        },
        snapshotToken: "snapshot-token",
        trackId: TRACK_ID,
      }),
    );
    expect(authorized?.status).toBe(200);
    expect(authorized?.headers.get("Cache-Control")).toBe("no-store");

    const committed = await handleOrpc(
      post("/capture/commit", AGENT_TOKEN, {
        commitToken: "commit-token",
        operationId: "track.capture",
        operationKey: "track.capture:receipt",
        requestDigest: "a".repeat(64),
        trackId: TRACK_ID,
      }),
    );
    expect(committed?.status).toBe(200);
    expect(await readJson(committed)).toMatchObject({
      ok: true,
      outcome: "committed",
      replayed: false,
    });
  });

  it("rejects a box-supplied YouTube officialness verdict", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/capture/authorize", AGENT_TOKEN, {
        result: {
          kind: "youtube-provenance",
          outcome: "youtube-found",
          verification: "preview-match",
          youtubeVideoId: "video-1",
          youtubeVideoOfficial: 1,
        },
        snapshotToken: "snapshot-token",
        trackId: TRACK_ID,
      }),
    );

    expect(response?.status).toBe(400);
    expect(authorizeCaptureReconciliation).not.toHaveBeenCalled();
  });
});

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

  it("maps the render's diversity-ledger trio — the finalize-miss correction path", async () => {
    updateTrack.mockResolvedValueOnce({
      fields: ["videoVehicle", "videoGrain", "videoRegister", "videoPalette"],
      trackId: TRACK_ID,
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(OPERATOR_TOKEN, {
        videoGrain: "grainBayer",
        videoPalette: "  amber-warm  ",
        videoRegister: "representational",
        videoVehicle: "  arch in the shallows  ",
      }),
    );

    expect(response?.status).toBe(200);

    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      {
        videoGrain: "grainBayer",
        videoPalette: "amber-warm",
        videoRegister: "representational",
        videoVehicle: "arch in the shallows",
      },
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

    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect("captureStatus" in update).toBe(false);
    expect(update.sourceAudioKey).toBe("004.7.2I/abc123.opus");
  });

  it.each(YOUTUBE_VERIFICATION_VALUES)(
    "forwards the sweep verdict %s to updateTrack",
    async (youtubeVerification) => {
      updateTrack.mockResolvedValueOnce({ fields: ["youtube_verification"], trackId: TRACK_ID });

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(patch(AGENT_TOKEN, { youtubeVerification }));

      expect(response?.status).toBe(200);
      expect(updateTrack).toHaveBeenCalledWith(
        TRACK_ID,
        { youtubeVerification },
        { writer: "agent" },
      );
    },
  );

  it.each(["soundcloud-preview-match", "soundcloud-archive-match"] as const)(
    "forwards the exact SoundCloud provenance verdict %s",
    async (sourceVerification) => {
      updateTrack.mockResolvedValueOnce({ fields: ["source_verification"], trackId: TRACK_ID });

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(patch(AGENT_TOKEN, { sourceVerification }));

      expect(response?.status).toBe(200);
      expect(updateTrack).toHaveBeenCalledWith(
        TRACK_ID,
        { sourceVerification },
        { writer: "agent" },
      );
    },
  );

  it("pins every sweep-emitted verdict to the handler's domain-owned vocabulary", () => {
    const source = readFileSync(
      new URL("../../../../../docs/agents/hermes/scripts/capture-sweep.ts", import.meta.url),
      "utf8",
    );
    const emitted = [...source.matchAll(/youtubeVerification:\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    const emittedSet = [...new Set(emitted)].sort((a, b) => a.localeCompare(b));
    const acceptedSet = [...YOUTUBE_VERIFICATION_VALUES].sort((a, b) => a.localeCompare(b));

    expect(emittedSet.every((verdict) => isYoutubeVerification(verdict))).toBe(true);
    expect(emittedSet).toEqual(acceptedSet);
  });

  it("drops an unrecognised SoundCloud provenance verdict while preserving valid fields", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["source_audio_key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, {
        sourceAudioKey: "004.7.2I/abc123.opus",
        sourceVerification: "soundcloud-maybe-match",
      }),
    );

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      { sourceAudioKey: "004.7.2I/abc123.opus" },
      { writer: "agent" },
    );
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

  it("threads the AUTHENTICATED tier to updateTrack, ignoring a body-supplied writer", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["key"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      patch(AGENT_TOKEN, { key: "F minor", writer: "operator" } as Record<string, unknown>),
    );

    expect(response?.status).toBe(200);

    const [, update, options] = updateTrack.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(options).toEqual({ writer: "agent" });
    expect("writer" in update).toBe(false);
  });
});

describe("oRPC observe_track (POST /admin/tracks/{trackId}/observe)", () => {
  it("401s with no admin token", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/observe", undefined, { script: GOOD_SCRIPT }));

    expect(response?.status).toBe(401);
    expect(renderObservationCartesia).not.toHaveBeenCalled();
  });

  it("lets the AGENT observe", async () => {
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

    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      contextNote: "Signature Records, 2008.",
      contextStatus: "resolved",
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationDurationMs: 28000,
      observationGeneratedAt: expect.any(String),

      observationPromptVersion: null,
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

    expect(fetchTrackContext).not.toHaveBeenCalled();

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

    expect(renderObservationCartesia).toHaveBeenCalled();
    expect(updateTrack).toHaveBeenCalled();
  });

  it("force + the UNCHANGED script preserves the stored prompt-version provenance (a re-render is not a re-author)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({
      ...TRACK,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1",
      observationDurationMs: 30000,
      observationGeneratedAt: "2026-06-01T00:00:00.000Z",
    });
    getObservationProvenance.mockResolvedValueOnce({ promptVersion: 3, script: GOOD_SCRIPT });
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", OPERATOR_TOKEN, { force: true, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      expect.objectContaining({ observationPromptVersion: 3 }),
    );
  });

  it("force with a NEW script does not inherit the prior script's provenance", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({
      ...TRACK,
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1",
      observationDurationMs: 30000,
      observationGeneratedAt: "2026-06-01T00:00:00.000Z",
    });
    getObservationProvenance.mockResolvedValueOnce({
      promptVersion: 3,
      script: "A different stored script entirely, from another authoring pass.",
    });
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/observe", OPERATOR_TOKEN, { force: true, script: GOOD_SCRIPT }),
    );

    expect(response?.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(
      TRACK_ID,
      expect.objectContaining({ observationPromptVersion: null }),
    );
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

  describe("the echo gate (the vibe-neighbour layer's guardrail, before the render spend)", () => {
    it("422s a script that lifts a phrase from a sonic neighbour — HELD, and no render spent", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

      observationNeighbours.mockResolvedValueOnce([
        {
          logId: "027.2.8R",
          script:
            "Knees went up before I clocked the coordinate on this one, a hard even roller all the way through.",
        },
      ]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/observe", AGENT_TOKEN, { promptVersion: 3, script: GOOD_SCRIPT }),
      );

      expect(response?.status).toBe(422);
      expect(((await readJson(response)) as { code: string }).code).toBe(
        "observation_echoes_neighbours",
      );

      expect(recordObservationRejection).toHaveBeenCalledTimes(1);
      expect(renderObservationCartesia).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(updateTrack).not.toHaveBeenCalled();
    });

    it("passes an honestly-different script over the same neighbourhood", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });
      observationNeighbours.mockResolvedValueOnce([
        {
          logId: "027.2.8R",
          script: "The pads hang like weather over a patient half-step, tide-slow and warm.",
        },
      ]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/observe", AGENT_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
      );

      expect(response?.status).toBe(200);
      expect(recordObservationRejection).not.toHaveBeenCalled();
      expect(renderObservationCartesia).toHaveBeenCalled();
    });

    it("an empty neighbourhood has nothing to echo — the script passes untouched", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });
      observationNeighbours.mockResolvedValueOnce([]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/observe", AGENT_TOKEN, { durationMs: 28000, script: GOOD_SCRIPT }),
      );

      expect(response?.status).toBe(200);
      expect(renderObservationCartesia).toHaveBeenCalled();
    });

    it("force SKIPS the echo gate — a deliberate operator re-render is an overrule", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce({
        ...TRACK,
        observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3?v=1",
      });
      updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK_ID });

      observationNeighbours.mockResolvedValueOnce([{ logId: "027.2.8R", script: GOOD_SCRIPT }]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/observe", OPERATOR_TOKEN, { force: true, script: GOOD_SCRIPT }),
      );

      expect(response?.status).toBe(200);

      expect(observationNeighbours).not.toHaveBeenCalled();
      expect(renderObservationCartesia).toHaveBeenCalled();
    });

    it("a ledger failure never turns the 422 into a 500 (best-effort hold)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      observationNeighbours.mockResolvedValueOnce([
        {
          logId: "027.2.8R",
          script: "Knees went up before I clocked the coordinate on this one, a hard even roller.",
        },
      ]);
      recordObservationRejection.mockRejectedValueOnce(new Error("ledger down"));

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(post("/observe", AGENT_TOKEN, { script: GOOD_SCRIPT }));

      expect(response?.status).toBe(422);
      expect(renderObservationCartesia).not.toHaveBeenCalled();
    });
  });
});

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

describe("oRPC note_track (POST /admin/tracks/{trackId}/note)", () => {
  const GOOD_NOTE = "Pure rolling menace, half-step and patient. That is why it is here.";

  it("401s with no admin token (the adminAuth tier)", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", undefined, { note: GOOD_NOTE }));

    expect(response?.status).toBe(401);
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("lets the AGENT author + store the note on an EMPTY-note finding", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    fillEmptyNote.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { note: string; ok: boolean; skipped?: boolean };
    expect(data.ok).toBe(true);
    expect(data.skipped).toBeUndefined();
    expect(data.note).toBe(GOOD_NOTE);

    expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, GOOD_NOTE, undefined);
    expect(updateTrack).not.toHaveBeenCalled();

    expect(recordNoteAttempt).toHaveBeenCalledWith(TRACK_ID, true);
  });

  it("FORWARDS the sweep's promptVersion into the atomic fill (the provenance stamp)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    fillEmptyNote.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/note", AGENT_TOKEN, { note: GOOD_NOTE, promptVersion: 5 }),
    );

    expect(response?.status).toBe(200);

    expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, GOOD_NOTE, 5);
  });

  it("reports skipped when a concurrent note wins the atomic fill race", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    fillEmptyNote.mockResolvedValueOnce(false);

    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, note: "The note that won the race." });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { note: string; ok: boolean; skipped?: boolean };
    expect(data.skipped).toBe(true);
    expect(data.note).toBe("The note that won the race.");

    expect(recordNoteAttempt).toHaveBeenCalledWith(TRACK_ID, false);
  });

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

    expect(data.note).toBe("The operator's own hand-written note.");

    expect(updateTrack).not.toHaveBeenCalled();

    expect(recordNoteAttempt).toHaveBeenCalledWith(TRACK_ID, false);
  });

  it("treats a whitespace-only stored note as empty and fills it", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, note: undefined });
    fillEmptyNote.mockResolvedValueOnce(true);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(200);
    expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, GOOD_NOTE, undefined);
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

  it("404s a CATALOGUE track — an uncertified track can NEVER be given a note", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

    expect(response?.status).toBe(404);
    expect(fillEmptyNote).not.toHaveBeenCalled();
    expect(updateTrack).not.toHaveBeenCalled();
  });

  describe("the echo gate (the vibe-neighbour layer's guardrail)", () => {
    const NEIGHBORS = [
      {
        logId: "027.2.8R",
        note: "My shoulders dropped before the break even settled; Eternity earns it.",
        trackId: "neighbor-1",
      },
      {
        logId: "012.2.4L",
        note: "Liquid roller with nocturnal depth; I have been rewinding this Krakota banger since 2018.",
        trackId: "neighbor-2",
      },
    ];

    it("422s `note_echoes_neighbours` when the note lifts a phrase from a neighbour", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce(NEIGHBORS);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, {
          note: "My shoulders dropped before I caught the title; that is Calibre doing what Calibre does.",
        }),
      );

      expect(response?.status).toBe(422);
      const data = (await readJson(response)) as { code: string; message: string };
      expect(data.code).toBe("note_echoes_neighbours");

      expect(data.message).toContain("027.2.8R");

      expect(fillEmptyNote).not.toHaveBeenCalled();
      expect(updateTrack).not.toHaveBeenCalled();

      expect(recordNoteRejection).toHaveBeenCalledTimes(1);
      const [trackId, held, echo, thresholds] = recordNoteRejection.mock.calls[0] ?? [];
      expect(trackId).toBe(TRACK_ID);
      expect(held).toContain("My shoulders dropped before");

      expect(echo).toMatchObject({
        echoes: true,
        logId: "027.2.8R",
        phrase: "my shoulders dropped before",
      });
      expect(thresholds).toEqual({ maxOverlap: 0.3, minPhraseWords: 4 });
    });

    it("a DRY RUN holds nothing — it is a measurement harness, not a queue-filler", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce(NEIGHBORS);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, {
          dryRun: true,
          note: "My shoulders dropped before I caught the title; that is Calibre doing what Calibre does.",
        }),
      );

      expect(response?.status).toBe(422);

      expect(recordNoteRejection).not.toHaveBeenCalled();
      expect(fillEmptyNote).not.toHaveBeenCalled();
    });

    it("a note that CLEARS the gate holds nothing (the ledger only records refusals)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce(NEIGHBORS);
      fillEmptyNote.mockResolvedValueOnce(true);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, {
          note: "Piano loops into your chest and the vocal keeps you pinned there.",
        }),
      );

      expect(response?.status).toBe(200);
      expect(fillEmptyNote).toHaveBeenCalled();
      expect(recordNoteRejection).not.toHaveBeenCalled();
    });

    it("stores a note that says something the neighbourhood does not", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce(NEIGHBORS);
      fillEmptyNote.mockResolvedValueOnce(true);

      const note = "Piano loops into your chest and the vocal keeps you pinned there.";
      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(post("/note", AGENT_TOKEN, { note }));

      expect(response?.status).toBe(200);
      expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, note, undefined);

      const data = (await readJson(response)) as { echo: { phrase: string } };
      expect(data.echo.phrase).toBe("");
    });

    it("gates against the SAME neighbours the agent was shown (the six nearest)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce([]);
      fillEmptyNote.mockResolvedValueOnce(true);

      const { handleOrpc } = await import("./orpc");
      await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

      expect(getSimilarFindings).toHaveBeenCalledWith(TRACK_ID, 6);
    });

    it("passes untouched when the finding has no neighbourhood yet (no embedding)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce([]);
      fillEmptyNote.mockResolvedValueOnce(true);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

      expect(response?.status).toBe(200);
      expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, GOOD_NOTE, undefined);
    });

    it("ignores a note-less neighbour (nothing to learn from, nothing to echo)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce([{ logId: "011.1.3X", trackId: "neighbor-3" }]);
      fillEmptyNote.mockResolvedValueOnce(true);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(post("/note", AGENT_TOKEN, { note: GOOD_NOTE }));

      expect(response?.status).toBe(200);
      expect(fillEmptyNote).toHaveBeenCalledWith(TRACK_ID, GOOD_NOTE, undefined);
    });
  });

  describe("--dry-run", () => {
    it("runs BOTH gates and stores NOTHING", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce([
        { logId: "027.2.8R", note: "A neighbour's note.", trackId: "neighbor-1" },
      ]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, { dryRun: true, note: GOOD_NOTE }),
      );

      expect(response?.status).toBe(200);
      const data = (await readJson(response)) as {
        dryRun: boolean;
        echo: { overlap: number };
        neighbors: string[];
        note: string;
      };
      expect(data.dryRun).toBe(true);
      expect(data.note).toBe(GOOD_NOTE);
      expect(data.neighbors).toEqual(["027.2.8R"]);

      expect(fillEmptyNote).not.toHaveBeenCalled();
      expect(updateTrack).not.toHaveBeenCalled();
      expect(recordNoteAttempt).not.toHaveBeenCalled();
    });

    it("still 422s an echoing note (the gates are the point of the dry run)", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
      getSimilarFindings.mockResolvedValueOnce([
        {
          logId: "027.2.8R",
          note: "My shoulders dropped before the break even settled; Eternity earns it.",
          trackId: "neighbor-1",
        },
      ]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, {
          dryRun: true,
          note: "My shoulders dropped before I caught the title; that is Calibre all over.",
        }),
      );

      expect(response?.status).toBe(422);
      expect(((await readJson(response)) as { code: string }).code).toBe("note_echoes_neighbours");
    });

    it("evaluates an already-noted finding without touching its note", async () => {
      getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, note: "The operator's own note." });
      getSimilarFindings.mockResolvedValueOnce([]);

      const { handleOrpc } = await import("./orpc");
      const response = await handleOrpc(
        post("/note", AGENT_TOKEN, { dryRun: true, note: GOOD_NOTE }),
      );

      expect(response?.status).toBe(200);
      const data = (await readJson(response)) as { dryRun: boolean; note: string; skipped?: true };
      expect(data.dryRun).toBe(true);
      expect(data.note).toBe(GOOD_NOTE);
      expect(data.skipped).toBeUndefined();
      expect(fillEmptyNote).not.toHaveBeenCalled();
      expect(updateTrack).not.toHaveBeenCalled();
    });
  });
});

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
        videoPalette: "amber-warm",
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
    expect(update.videoPalette).toBe("amber-warm");
    expect(update.videoModel).toBe("anthropic/claude-opus-5");
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

  it("fills missing stamps from the bundle's render.json on R2", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });
    bucketGet.mockResolvedValueOnce({
      json: async () => ({
        grain: "grainFineEmulsion",
        model: "anthropic/claude-opus-5",
        palette: "teal-cool",

        plateSubject: "ruin",
        reasoning: "high",
        register: "representational",
        structure: { confidence: 0.8, dominant: "filament" },
        vehicle: "tidal retreat",
      }),
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/finalize", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    expect(bucketGet).toHaveBeenCalledWith("004.7.2I/render.json");
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBe("tidal retreat");
    expect(update.videoGrain).toBe("grainFineEmulsion");
    expect(update.videoRegister).toBe("representational");

    expect(update.videoPalette).toBe("teal-cool");

    expect(update.videoPlateSubject).toBe("ruin");
    expect(update.videoStructure).toBe("filament");
  });

  it("skips the R2 read when the body already carries the full set (incl. structure + plate subject)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");

    const response = await handleOrpc(
      post("/video/finalize", AGENT_TOKEN, {
        videoGrain: "grainBayer",
        videoPalette: "blue-cool",
        videoPlateSubject: "hull",
        videoRegister: "abstract",
        videoStructure: "cellular",
        videoVehicle: "thermal raptor",
      }),
    );

    expect(response?.status).toBe(200);
    expect(bucketGet).not.toHaveBeenCalled();
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBe("thermal raptor");
    expect(update.videoPalette).toBe("blue-cool");
    expect(update.videoStructure).toBe("cellular");
    expect(update.videoPlateSubject).toBe("hull");
  });

  it("reads the manifest to recover palette when the body carries the trio but not palette", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });
    bucketGet.mockResolvedValueOnce({ json: async () => ({ palette: "magenta-cool" }) });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      post("/video/finalize", AGENT_TOKEN, {
        videoGrain: "grainBayer",
        videoRegister: "abstract",
        videoVehicle: "thermal raptor",
      }),
    );

    expect(response?.status).toBe(200);
    expect(bucketGet).toHaveBeenCalledWith("004.7.2I/render.json");
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBe("thermal raptor");
    expect(update.videoPalette).toBe("magenta-cool");
  });

  it("lands the finalize unstamped when no manifest exists (best-effort, never a failure)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: ["video_url"], trackId: TRACK_ID });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/finalize", AGENT_TOKEN, {}));

    expect(response?.status).toBe(200);
    const [, update] = updateTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(update.videoVehicle).toBeUndefined();
    expect(update.videoModel).toBe("anthropic/claude-opus-5");
  });
});

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

    expect(data.alreadyClear).toBeUndefined();

    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { videoSquaredAt: "", videoUrl: "" });
  });

  it("is idempotent: an already-clear finding is a no-op (alreadyClear, no write)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(post("/video/requeue", OPERATOR_TOKEN, {}));

    expect(response?.status).toBe(200);
    const data = (await readJson(response)) as { alreadyClear?: boolean; ok: boolean };
    expect(data.ok).toBe(true);
    expect(data.alreadyClear).toBe(true);

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

function captureSourceRequest(method: "DELETE" | "PUT", token: string | undefined, body?: unknown) {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/${TRACK_ID}/capture-source`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers,
    method,
  });
}

const PINNED = {
  captureSourcePin: "dQw4w9WgXcQ",
  captureSourcePinAllowDuration: false,
  captureStatus: "pending",
  logId: "004.7.2I",
  trackId: TRACK_ID,
};

describe("oRPC pin_capture_source (PUT .../capture-source)", () => {
  it("401s with no admin token, 403s the AGENT — the pin is the operator's alone", async () => {
    const { handleOrpc } = await import("./orpc");

    const anonymous = await handleOrpc(
      captureSourceRequest("PUT", undefined, { youtubeVideoId: "dQw4w9WgXcQ" }),
    );
    expect(anonymous?.status).toBe(401);

    const agent = await handleOrpc(
      captureSourceRequest("PUT", AGENT_TOKEN, { youtubeVideoId: "dQw4w9WgXcQ" }),
    );
    expect(agent?.status).toBe(403);
    expect(((await readJson(agent)) as { code: string }).code).toBe("forbidden");
    expect(pinCaptureSource).not.toHaveBeenCalled();
  });

  it("reduces a pasted YouTube URL to its id SERVER-SIDE before the write", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pinCaptureSource.mockResolvedValueOnce(PINNED);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      captureSourceRequest("PUT", OPERATOR_TOKEN, {
        youtubeVideoId: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xyz",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({ ...PINNED, ok: true });

    expect(pinCaptureSource).toHaveBeenCalledWith(TRACK_ID, "dQw4w9WgXcQ", {
      allowDurationMismatch: false,
    });
  });

  it("passes `allowDurationMismatch` through to the write and reports the waiver back", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    pinCaptureSource.mockResolvedValueOnce({ ...PINNED, captureSourcePinAllowDuration: true });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      captureSourceRequest("PUT", OPERATOR_TOKEN, {
        allowDurationMismatch: true,
        youtubeVideoId: "dQw4w9WgXcQ",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ...PINNED,
      captureSourcePinAllowDuration: true,
      ok: true,
    });
    expect(pinCaptureSource).toHaveBeenCalledWith(TRACK_ID, "dQw4w9WgXcQ", {
      allowDurationMismatch: true,
    });
  });

  it("400s `invalid_youtube_video_id` for a paste that is not a YouTube upload — nothing written", async () => {
    const { handleOrpc } = await import("./orpc");

    for (const youtubeVideoId of [
      "https://soundcloud.com/artist/track",
      "not an id",
      "https://www.youtube.com/@channel",
    ]) {
      const response = await handleOrpc(
        captureSourceRequest("PUT", OPERATOR_TOKEN, { youtubeVideoId }),
      );

      expect(response?.status).toBe(400);
      expect(((await readJson(response)) as { code: string }).code).toBe(
        "invalid_youtube_video_id",
      );
    }
    expect(pinCaptureSource).not.toHaveBeenCalled();
    expect(getTrackByIdOrLogId).not.toHaveBeenCalled();
  });

  it("404s `not_found` for an unknown track", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(undefined);

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(
      captureSourceRequest("PUT", OPERATOR_TOKEN, { youtubeVideoId: "dQw4w9WgXcQ" }),
    );

    expect(response?.status).toBe(404);
    expect(((await readJson(response)) as { code: string }).code).toBe("not_found");
    expect(pinCaptureSource).not.toHaveBeenCalled();
  });
});

describe("oRPC clear_capture_source (DELETE .../capture-source)", () => {
  it("403s the AGENT — withdrawing the operator's ruling is his alone", async () => {
    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(captureSourceRequest("DELETE", AGENT_TOKEN));

    expect(response?.status).toBe(403);
    expect(clearCaptureSource).not.toHaveBeenCalled();
  });

  it("clears the pin for the operator and reports the row as it stands", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    clearCaptureSource.mockResolvedValueOnce({
      ...PINNED,
      captureSourcePin: null,
      captureStatus: "done",
    });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(captureSourceRequest("DELETE", OPERATOR_TOKEN));

    expect(response?.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ...PINNED,
      captureSourcePin: null,
      captureStatus: "done",
      ok: true,
    });
    expect(clearCaptureSource).toHaveBeenCalledWith(TRACK_ID);
  });
});

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

    expect(body.tracks[0]?.sourceAudioKey).toBe("004.7.2I/abc123.m4a");
  });

  it("leaves captureQueue false when absent (a separate, opt-in queue)", async () => {
    listTracks.mockResolvedValueOnce({ totalCount: 0, tracks: [] });

    const { handleOrpc } = await import("./orpc");
    const response = await handleOrpc(adminGet("?hasEmbedding=false", AGENT_TOKEN));

    expect(response?.status).toBe(200);
    const [opts] = listTracks.mock.calls[0] as [Record<string, unknown>];

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

    expect(body.code).toBe("not_found");
    expect(body.message).toBe("No track with id 000.0.0X");
  });
});

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
    expect(((await readJson(response)) as { code: string }).code).toBe("forbidden");
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
