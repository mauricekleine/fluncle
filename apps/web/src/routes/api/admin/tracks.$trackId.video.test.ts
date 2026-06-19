import { beforeAll, describe, expect, it, vi } from "vitest";

// The track lookup and the DB write are mocked: these tests cover the route's
// auth gate, request shaping, presigned-URL response, and finalize linkage —
// not Turso. A live R2 round-trip is the operator's check (creds + prod only).
const TRACK = { logId: "004.7.2I", trackId: "track-123" };

const getTrackByIdOrLogId = vi.fn();
const updateTrack = vi.fn();

vi.mock("../../../lib/server/tracks", () => ({
  getTrackByIdOrLogId: (id: string) => getTrackByIdOrLogId(id),
}));

vi.mock("../../../lib/server/track-update", () => ({
  updateTrack: (...args: unknown[]) => updateTrack(...args),
}));

const TOKEN = "test-token-video-routes";
const ACCOUNT_ID = "0651fd3b33d9e0b2fe72a5f13e5cf65d";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
  process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
  process.env.R2_ACCOUNT_ID = ACCOUNT_ID;
});

function adminPost(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

async function postHandler(routeModule: {
  Route: unknown;
}): Promise<(opts: { params: Record<string, string>; request: Request }) => Promise<Response>> {
  // The file-route options object carries the server handlers we registered.
  const route = routeModule.Route as {
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

describe("POST .../video/uploads (presign)", () => {
  it("returns a presigned PUT URL per requested artifact, keyed at <log-id>/<name>", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { Route } = await import("./tracks.$trackId.video.uploads");
    const POST = await postHandler({ Route });

    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost("https://www.fluncle.com/api/admin/tracks/004.7.2I/video/uploads", {
        fields: ["footage", "cover"],
      }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      logId: string;
      uploads: Array<{ contentType: string; field: string; key: string; url: string }>;
    };

    expect(data.logId).toBe("004.7.2I");
    expect(data.uploads.map((u) => u.field)).toEqual(["footage", "cover"]);

    const footage = data.uploads.find((u) => u.field === "footage")!;
    expect(footage.key).toBe("004.7.2I/footage.mp4");
    expect(footage.contentType).toBe("video/mp4");

    const url = new URL(footage.url);
    expect(url.host).toBe(`${ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe("/fluncle-videos/004.7.2I/footage.mp4");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
  });

  it("401s without the admin Bearer token", async () => {
    const { Route } = await import("./tracks.$trackId.video.uploads");
    const POST = await postHandler({ Route });

    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: new Request("https://www.fluncle.com/api/admin/tracks/004.7.2I/video/uploads", {
        body: JSON.stringify({ fields: ["footage"] }),
        method: "POST",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("requires the footage cut", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);

    const { Route } = await import("./tracks.$trackId.video.uploads");
    const POST = await postHandler({ Route });

    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost("https://www.fluncle.com/api/admin/tracks/004.7.2I/video/uploads", {
        fields: ["cover"],
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("no_footage");
  });
});

describe("POST .../video/finalize", () => {
  it("sets video_url to the footage cut and stores the vehicle + model + reasoning", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK.trackId });

    const { Route } = await import("./tracks.$trackId.video.finalize");
    const POST = await postHandler({ Route });

    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost("https://www.fluncle.com/api/admin/tracks/004.7.2I/video/finalize", {
        videoModel: "anthropic/claude-sonnet-4-5",
        videoModelReasoning: "medium",
        videoVehicle: "submarine",
      }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { videoUrl: string };
    expect(data.videoUrl).toBe("https://found.fluncle.com/004.7.2I/footage.mp4");

    expect(updateTrack).toHaveBeenCalledWith(TRACK.trackId, {
      videoModel: "anthropic/claude-sonnet-4-5",
      videoModelReasoning: "medium",
      videoUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
      videoVehicle: "submarine",
    });
  });

  it("defaults the model to anthropic/claude-opus-4-8 and reasoning to high when absent", async () => {
    getTrackByIdOrLogId.mockResolvedValueOnce(TRACK);
    updateTrack.mockResolvedValueOnce({ fields: [], trackId: TRACK.trackId });

    const { Route } = await import("./tracks.$trackId.video.finalize");
    const POST = await postHandler({ Route });

    const response = await POST({
      params: { trackId: "004.7.2I" },
      request: adminPost("https://www.fluncle.com/api/admin/tracks/004.7.2I/video/finalize", {
        videoVehicle: "submarine",
      }),
    });

    expect(response.status).toBe(200);

    expect(updateTrack).toHaveBeenCalledWith(TRACK.trackId, {
      videoModel: "anthropic/claude-opus-4-8",
      videoModelReasoning: "high",
      videoUrl: "https://found.fluncle.com/004.7.2I/footage.mp4",
      videoVehicle: "submarine",
    });
  });
});
