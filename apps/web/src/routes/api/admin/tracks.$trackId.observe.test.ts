import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The observe route's auth gate, voice gate, vendor relay, R2 upload, and write-
// back — with Turso, R2, firecrawl, and ElevenLabs all mocked. A live render is
// the operator's check (a paid ElevenLabs call). The voice gate's pure scan is
// covered exhaustively in observation.test.ts; here we assert the route wires it.
const TRACK = {
  artists: ["Calibre"],
  label: "Signature",
  logId: "004.7.2I",
  releaseDate: "2008",
  title: "Mr Right On",
  trackId: "track-123",
};

const getTrackByIdOrLogId = vi.fn();
const updateTrack = vi.fn();
const put = vi.fn();
const renderObservation = vi.fn();
const fetchTrackContext = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: { VIDEOS: { put: (...args: unknown[]) => put(...args) } },
}));

vi.mock("../../../lib/server/tracks", () => ({
  getTrackByIdOrLogId: (id: string) => getTrackByIdOrLogId(id),
}));

vi.mock("../../../lib/server/track-update", () => ({
  updateTrack: (...args: unknown[]) => updateTrack(...args),
}));

vi.mock("../../../lib/server/observation", async () => {
  // Keep the REAL voice gate (gateObservationScript / scanObservationScript) and
  // defaults; only the vendor I/O (firecrawl + ElevenLabs) is faked.
  const actual = await vi.importActual<typeof import("../../../lib/server/observation")>(
    "../../../lib/server/observation",
  );

  return {
    ...actual,
    fetchTrackContext: (query: string) => fetchTrackContext(query),
    renderObservation: (...args: unknown[]) => renderObservation(...args),
    resolveVoiceId: async (override?: string) => override ?? "voice-stock-1",
  };
});

const TOKEN = "test-token-observe";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
});

beforeEach(() => {
  put.mockReset();
  updateTrack.mockReset().mockResolvedValue({ fields: [], trackId: TRACK.trackId });
  renderObservation
    .mockReset()
    .mockResolvedValue({ bytes: new ArrayBuffer(512), voiceId: "voice-stock-1" });
  fetchTrackContext.mockReset().mockResolvedValue({
    contextNote: "Signature Records, 2008.",
    sources: ["https://example.com"],
  });
  getTrackByIdOrLogId.mockReset();
});

function adminPost(body: unknown): Request {
  return new Request("https://www.fluncle.com/api/admin/tracks/004.7.2I/observe", {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

async function postHandler() {
  const { Route } = await import("./tracks.$trackId.observe");
  const route = Route as unknown as {
    options: {
      server: {
        handlers: {
          POST: (opts: { params: Record<string, string>; request: Request }) => Promise<Response>;
        };
      };
    };
  };

  return route.options.server.handlers.POST;
}

const GOOD_SCRIPT =
  "Arrived on the dark side of the sector and this one moved at a hard, even pace. Knees went up before I clocked the coordinate. Logged it as fluncle://004.7.2I. Hope it gets an oof out of you, fam.";

describe("POST .../observe", () => {
  it("renders, uploads three R2 objects, and writes the observation fields back", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const POST = await postHandler();
    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost({ durationMs: 28000, script: GOOD_SCRIPT }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { audioUrl: string; durationMs: number; ok: boolean };
    expect(data.ok).toBe(true);
    expect(data.audioUrl).toBe("https://found.fluncle.com/004.7.2I/observation.mp3");
    expect(data.durationMs).toBe(28000);

    // mp3 + txt + json at <log-id>/<name>.
    expect(put.mock.calls.map((call) => call[0])).toEqual([
      "004.7.2I/observation.mp3",
      "004.7.2I/observation.txt",
      "004.7.2I/observation.json",
    ]);

    expect(updateTrack).toHaveBeenCalledWith(TRACK.trackId, {
      contextNote: "Signature Records, 2008.",
      observationAudioUrl: "https://found.fluncle.com/004.7.2I/observation.mp3",
      observationDurationMs: 28000,
      observationGeneratedAt: expect.any(String),
    });
  });

  it("estimates duration from the target when the agent omits durationMs", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const POST = await postHandler();
    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost({ durationTargetSec: 35, script: GOOD_SCRIPT }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { durationMs: number }).durationMs).toBe(35000);
  });

  it("rejects a script with a banned identity word before spending a render", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const POST = await postHandler();
    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost({
        script:
          "The signal carried a clean pace and the knees went up. Logged it as fluncle://004.7.2I, fam.",
      }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("voice_gate");
    expect(renderObservation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("401s without the admin Bearer token", async () => {
    const POST = await postHandler();
    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: new Request("https://www.fluncle.com/api/admin/tracks/004.7.2I/observe", {
        body: JSON.stringify({ script: GOOD_SCRIPT }),
        method: "POST",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("400s a track with no Log ID (no R2 coordinate)", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce({ ...TRACK, logId: undefined });

    const POST = await postHandler();
    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost({ script: GOOD_SCRIPT }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("no_log_id");
  });
});
