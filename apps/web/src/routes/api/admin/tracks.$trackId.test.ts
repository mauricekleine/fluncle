import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the PATCH /api/admin/tracks/:id note paths: setting, clearing (the
// regression — `note: ""` must write `""`, not no-op), leaving it absent, and
// the 422 over-length guard. updateTrack is mocked; the route's job is to shape
// the update correctly, not to touch Turso.
const updateTrack = vi.fn();

vi.mock("../../../lib/server/track-update", () => ({
  TrackUpdate: {},
  updateTrack: (...args: unknown[]) => updateTrack(...args),
}));

const TOKEN = "test-token-track-patch-route";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
});

beforeEach(() => {
  updateTrack.mockReset();
});

function adminPatch(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    method: "PATCH",
  });
}

async function patchHandler(routeModule: {
  Route: unknown;
}): Promise<(opts: { params: Record<string, string>; request: Request }) => Promise<Response>> {
  const route = routeModule.Route as {
    options: {
      server: {
        handlers: {
          PATCH: (opts: { params: Record<string, string>; request: Request }) => Promise<Response>;
        };
      };
    };
  };

  return route.options.server.handlers.PATCH;
}

const TRACK_ID = "track-123";

describe("PATCH /api/admin/tracks/:id (note)", () => {
  it("clears the stored note when `note` is an empty string", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    const response = await PATCH({
      params: { trackId: TRACK_ID },
      request: adminPatch(`https://www.fluncle.com/api/admin/tracks/${TRACK_ID}`, { note: "" }),
    });

    expect(response.status).toBe(200);
    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { note: "" });
  });

  it("sets the note when `note` is a non-empty string", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["note"], trackId: TRACK_ID });

    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    await PATCH({
      params: { trackId: TRACK_ID },
      request: adminPatch(`https://www.fluncle.com/api/admin/tracks/${TRACK_ID}`, {
        note: "A tight one-or-two-sentence take.",
      }),
    });

    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, {
      note: "A tight one-or-two-sentence take.",
    });
  });

  it("leaves the note untouched when `note` is absent from the body", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["bpm"], trackId: TRACK_ID });

    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    await PATCH({
      params: { trackId: TRACK_ID },
      request: adminPatch(`https://www.fluncle.com/api/admin/tracks/${TRACK_ID}`, { bpm: 174 }),
    });

    expect(updateTrack).toHaveBeenCalledWith(TRACK_ID, { bpm: 174 });
  });

  it("rejects a note over the 280-character budget with a 422", async () => {
    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    const response = await PATCH({
      params: { trackId: TRACK_ID },
      request: adminPatch(`https://www.fluncle.com/api/admin/tracks/${TRACK_ID}`, {
        note: "x".repeat(281),
      }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("note_too_long");
    expect(updateTrack).not.toHaveBeenCalled();
  });
});
