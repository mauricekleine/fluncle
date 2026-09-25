import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOKEN, OPERATOR_TOKEN, setAdminTokenEnv } from "../../../lib/server/orpc-test-kit";

const sourceAudioGet = vi.fn();
const getPreviewArchiveMetadata = vi.fn();

vi.mock("cloudflare:workers", () => ({
  env: {
    SOURCE_AUDIO: { get: (...args: unknown[]) => sourceAudioGet(...args) },
  },
}));

vi.mock("../../../lib/server/preview-archive", () => ({
  getPreviewArchiveMetadata: (...args: unknown[]) => getPreviewArchiveMetadata(...args),
}));

const { serverHandlers } = await import("./tracks.$trackId.preview-audio");

const TRACK_ID = "004.7.2I";
const NEW_KEY = "004.7.2I/deadbeef.mp3";
const LEGACY_KEY = "analysis/previews/004.7.2I/deadbeef.mp3";
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function fakeObject(storedContentType?: string) {
  return {
    body: BYTES,
    size: BYTES.byteLength,
    writeHttpMetadata: (headers: Headers) => {
      if (storedContentType) {
        headers.set("Content-Type", storedContentType);
      }
    },
  };
}

function metadata(overrides: Record<string, unknown>) {
  return {
    archivedAt: "2026-06-01T00:00:00.000Z",
    key: NEW_KEY,
    logId: TRACK_ID,
    mime: "audio/mpeg",
    source: "deezer",
    trackId: "track-123",
    ...overrides,
  };
}

function request(token: string | undefined): Request {
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request(`https://www.fluncle.com/api/v1/admin/tracks/${TRACK_ID}/preview-audio`, {
    headers,
    method: "GET",
  });
}

function callGet(token: string | undefined) {
  const handler = serverHandlers.GET;

  if (!handler) {
    throw new Error("preview-audio route is missing its GET handler");
  }

  return handler({ params: { trackId: TRACK_ID }, request: request(token) });
}

beforeAll(setAdminTokenEnv);

beforeEach(() => {
  sourceAudioGet.mockReset();
  getPreviewArchiveMetadata.mockReset();
});

describe("GET /api/admin/tracks/:idOrLogId/preview-audio", () => {
  it("streams a new-style key from the PRIVATE SOURCE_AUDIO bucket (agent token passes)", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(metadata({ key: NEW_KEY }));
    sourceAudioGet.mockResolvedValue(fakeObject());

    const res = await callGet(AGENT_TOKEN);

    expect(res.status).toBe(200);
    expect(sourceAudioGet).toHaveBeenCalledWith(NEW_KEY);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("also serves the operator token (agent tier accepts operator)", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(metadata({ key: NEW_KEY }));
    sourceAudioGet.mockResolvedValue(fakeObject());

    const res = await callGet(OPERATOR_TOKEN);

    expect(res.status).toBe(200);
    expect(sourceAudioGet).toHaveBeenCalledWith(NEW_KEY);
  });

  it("401s an unauthenticated request without touching the buckets", async () => {
    const res = await callGet(undefined);

    expect(res.status).toBe(401);
    expect(getPreviewArchiveMetadata).not.toHaveBeenCalled();
    expect(sourceAudioGet).not.toHaveBeenCalled();
  });

  it("404s a finding with no archived preview key", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(metadata({ key: "" }));

    const res = await callGet(AGENT_TOKEN);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("preview_unarchived");
    expect(sourceAudioGet).not.toHaveBeenCalled();
  });

  it("404s a missing finding", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(undefined);

    const res = await callGet(AGENT_TOKEN);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("track_not_found");
  });

  it("404s when the archived object is gone from R2", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(metadata({ key: NEW_KEY }));
    sourceAudioGet.mockResolvedValue(null);

    const res = await callGet(AGENT_TOKEN);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("preview_audio_missing");
  });

  it("404s a stale legacy analysis/previews key (it simply misses in SOURCE_AUDIO)", async () => {
    getPreviewArchiveMetadata.mockResolvedValue(metadata({ key: LEGACY_KEY }));
    sourceAudioGet.mockResolvedValue(null);

    const res = await callGet(AGENT_TOKEN);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe("preview_audio_missing");
    expect(sourceAudioGet).toHaveBeenCalledWith(LEGACY_KEY);
  });
});
