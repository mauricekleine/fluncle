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
const AGENT_TOKEN = "test-token-track-patch-agent";

beforeAll(() => {
  process.env.FLUNCLE_API_TOKEN = TOKEN;
  process.env.FLUNCLE_AGENT_TOKEN = AGENT_TOKEN;
});

beforeEach(() => {
  updateTrack.mockReset();
});

function patchAs(token: string, url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "PATCH",
  });
}

function adminPatch(url: string, body: unknown): Request {
  return patchAs(TOKEN, url, body);
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

// The agent role is bounded server-side to machine-measured analysis. An attempt
// at an operator-only field (note, vibe, video, identity) is a 403, not a silent
// drop — the box gate is no longer the boundary.
describe("PATCH /api/admin/tracks/:id (agent role field bounds)", () => {
  const agentPatch = (body: unknown) =>
    patchAs(AGENT_TOKEN, `https://www.fluncle.com/api/admin/tracks/${TRACK_ID}`, body);

  it("lets the agent write analysis fields", async () => {
    updateTrack.mockResolvedValueOnce({ fields: ["bpm", "key"], trackId: TRACK_ID });

    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    const response = await PATCH({
      params: { trackId: TRACK_ID },
      request: agentPatch({ bpm: 174, enrichmentStatus: "done", key: "F minor" }),
    });

    expect(response.status).toBe(200);
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
  ])("403s the agent writing %s, without touching the db", async (_field, body) => {
    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    const response = await PATCH({ params: { trackId: TRACK_ID }, request: agentPatch(body) });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("forbidden");
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it("403s a mixed payload (analysis + an operator field) wholesale", async () => {
    const { Route } = await import("./tracks.$trackId");
    const PATCH = await patchHandler({ Route });

    const response = await PATCH({
      params: { trackId: TRACK_ID },
      request: agentPatch({ bpm: 174, note: "sneaking a note in" }),
    });

    expect(response.status).toBe(403);
    expect(updateTrack).not.toHaveBeenCalled();
  });
});
