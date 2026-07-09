import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MixtapeDTO } from "../mixtapes";
import { type ServiceStatusRow } from "./status";
import { type TrackListItem } from "./tracks";

// `get_status` reads the status store; the resource + get_track paths read the log
// resolver and the recent-tracks list. We mock exactly those three so the JSON-RPC
// calls stay hermetic. The remaining tool dependencies (spotify, newsletter,
// submissions, and the rest of ./tracks) are imported by mcp.ts but never invoked by
// these calls, so they stay real (./tracks is partial-mocked: only listTracks swaps).
const statuses = vi.hoisted(() => vi.fn<() => Promise<ServiceStatusRow[]>>());
const resolveTarget = vi.hoisted(() => vi.fn());
const listTracksMock = vi.hoisted(() => vi.fn());

vi.mock("./status", () => ({
  getServiceStatuses: statuses,
}));

vi.mock("./log-resolver", () => ({
  resolveLogPageTarget: resolveTarget,
}));

vi.mock("./tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tracks")>()),
  listTracks: listTracksMock,
}));

const { handleMcp } = await import("./mcp");

// Aliased to the untyped hoisted mocks (mockResolvedValue takes the fixture as-is).
const resolveTargetMock = resolveTarget;
const recentTracksMock = listTracksMock;

// A minimal public finding, the shape resolveLogPageTarget hands back for a track.
function findingFixture(overrides: Partial<TrackListItem> = {}): TrackListItem {
  return {
    addedAt: "2026-06-15T20:00:00.000Z",
    addedToSpotify: true,
    artists: ["Camo & Krooked"],
    bpm: 172.6,
    durationMs: 215_000,
    enrichmentStatus: "done",
    key: "F minor",
    logId: "012.8.0A",
    logPageUrl: "https://www.fluncle.com/log/012.8.0A",
    note: "First-line hook.\nA second line the descriptor drops.",
    postedToTelegram: true,
    spotifyUrl: "https://open.spotify.com/track/abc",
    title: "Test Banger",
    trackId: "abc",
    type: "finding",
    ...overrides,
  };
}

// A minimal published mixtape, the shape resolveLogPageTarget hands back for the F form.
function mixtapeFixture(overrides: Partial<MixtapeDTO> = {}): MixtapeDTO {
  return {
    externalUrls: { mixcloud: "https://www.mixcloud.com/fluncle/set" },
    logId: "019.F.1A",
    memberCount: 1,
    members: [{ ...findingFixture(), startMs: 0 }],
    note: "A checkpoint set.",
    status: "published",
    title: "Fluncle Drum & Bass Mixtape #1 | 019.F.1A",
    type: "mixtape",
    ...overrides,
  } as MixtapeDTO;
}

async function rpc(
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await handleMcp(
    new Request("https://www.fluncle.com/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );

  if (!response) {
    throw new Error("handleMcp returned no response");
  }

  return (await response.json()) as Record<string, unknown>;
}

function row(overrides: Partial<ServiceStatusRow> & Pick<ServiceStatusRow, "service" | "status">) {
  return {
    checked_at: "2026-06-25T00:00:00.000Z",
    latency_ms: 42,
    message: null,
    since: "2026-06-25T00:00:00.000Z",
    ...overrides,
  } satisfies ServiceStatusRow;
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const response = await handleMcp(
    new Request("https://www.fluncle.com/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );

  if (!response) {
    throw new Error("handleMcp returned no response");
  }

  const body = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  const text = body.result.content[0]?.text ?? "{}";

  return { data: JSON.parse(text) as Record<string, unknown>, isError: body.result.isError };
}

describe("MCP get_status tool", () => {
  beforeEach(() => {
    statuses.mockReset();
  });

  it("is advertised in tools/list with a verb_noun name", async () => {
    const response = await handleMcp(
      new Request("https://www.fluncle.com/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    if (!response) {
      throw new Error("handleMcp returned no response");
    }

    const body = (await response.json()) as {
      result: { tools: Array<{ description: string; name: string; title: string }> };
    };
    const tool = body.result.tools.find((candidate) => candidate.name === "get_status");

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Are all systems up?");
  });

  it("reports ok with an all-up headline when every service is ok", async () => {
    statuses.mockResolvedValue([
      row({ service: "web", status: "ok" }),
      row({ service: "ssh", status: "ok" }),
    ]);

    const { data, isError } = await callTool("get_status");

    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.headline).toBe("All 2 Fluncle systems are operational.");
    expect(data.services).toHaveLength(2);
  });

  it("flips ok false and names the failing service when one is down", async () => {
    statuses.mockResolvedValue([
      row({ message: "502 from origin", service: "web", status: "down" }),
      row({ service: "ssh", status: "ok" }),
    ]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toContain("web down");
    const services = data.services as Array<{ message: string | null; name: string }>;
    expect(services[0]).toMatchObject({ message: "502 from origin", name: "web" });
  });

  it("treats degraded as not-ok and names it", async () => {
    statuses.mockResolvedValue([row({ service: "r2", status: "degraded" })]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toContain("r2 degraded");
  });

  it("labels each service from the surfaces registry", async () => {
    statuses.mockResolvedValue([row({ service: "r2", status: "ok" })]);

    const { data } = await callTool("get_status");
    const services = data.services as Array<{ label: string; name: string }>;

    expect(services[0]?.name).toBe("r2");
    // The registry's media-zone surface (operatorNotes: "…as service `r2`") supplies
    // the label, so it is never the bare id when the registry knows the service.
    expect(services[0]?.label).not.toBe("r2");
    expect(typeof services[0]?.label).toBe("string");
  });

  it("reports unknown (ok false) when the store is empty", async () => {
    statuses.mockResolvedValue([]);

    const { data } = await callTool("get_status");

    expect(data.ok).toBe(false);
    expect(data.headline).toBe("No service has reported its health yet.");
    expect(data.services).toHaveLength(0);
  });
});

describe("MCP initialize", () => {
  it("advertises tools, resources, and prompts capabilities", async () => {
    const body = (await rpc("initialize", { protocolVersion: "2025-06-18" })) as {
      result: { capabilities: Record<string, unknown> };
    };

    expect(body.result.capabilities).toMatchObject({
      prompts: { listChanged: false },
      resources: { listChanged: false },
      tools: { listChanged: false },
    });
  });
});

describe("MCP get_track tool", () => {
  beforeEach(() => {
    resolveTargetMock.mockReset();
  });

  it("is advertised in tools/list with a verb_noun name", async () => {
    const body = (await rpc("tools/list")) as {
      result: { tools: Array<{ name: string; title: string }> };
    };
    const tool = body.result.tools.find((candidate) => candidate.name === "get_track");

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Read one finding");
  });

  it("reads a finding's public record by coordinate", async () => {
    resolveTargetMock.mockResolvedValue({ kind: "track", track: findingFixture() });

    const { data, isError } = await callTool("get_track", { idOrLogId: "012.8.0A" });

    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    const track = data.track as Record<string, unknown>;
    expect(track).toMatchObject({
      artists: ["Camo & Krooked"],
      bpm: 173,
      coordinate: "012.8.0A",
      title: "Test Banger",
      type: "finding",
      uri: "fluncle://finding/012.8.0A",
    });
    expect(resolveTargetMock).toHaveBeenCalledWith("012.8.0A");
  });

  it("never leaks the private capture key in a finding read", async () => {
    resolveTargetMock.mockResolvedValue({
      kind: "track",
      track: findingFixture({ sourceAudioKey: "012.8.0A/deadbeef.opus" }),
    });

    const { data } = await callTool("get_track", { idOrLogId: "012.8.0A" });
    const track = data.track as Record<string, unknown>;

    expect(track.sourceAudioKey).toBeUndefined();
    expect(JSON.stringify(track)).not.toContain("deadbeef");
  });

  it("reads a mixtape's public record with its tracklist", async () => {
    resolveTargetMock.mockResolvedValue({ kind: "mixtape", mixtape: mixtapeFixture() });

    const { data, isError } = await callTool("get_track", { idOrLogId: "019.F.1A" });

    expect(isError).toBe(false);
    const mixtape = data.mixtape as Record<string, unknown>;
    expect(mixtape).toMatchObject({
      by: "Fluncle",
      coordinate: "019.F.1A",
      type: "mixtape",
      uri: "fluncle://mixtape/019.F.1A",
    });
    expect(mixtape.tracklist).toHaveLength(1);
  });

  it("returns a not-found tool error for an unknown coordinate", async () => {
    resolveTargetMock.mockResolvedValue(undefined);

    const { data, isError } = await callTool("get_track", { idOrLogId: "999.9.9Z" });

    expect(isError).toBe(true);
    expect(data.code).toBe("track_not_found");
  });
});

describe("MCP resources", () => {
  beforeEach(() => {
    resolveTargetMock.mockReset();
    recentTracksMock.mockReset();
  });

  it("lists recent findings and mixtapes as fluncle:// resources", async () => {
    recentTracksMock.mockResolvedValue({
      nextCursor: undefined,
      totalCount: 2,
      tracks: [
        findingFixture(),
        mixtapeFixture(),
        // An uncoordinated finding is skipped — no coordinate, no resource URI.
        findingFixture({ logId: undefined, trackId: "nope" }),
      ],
    });

    const body = (await rpc("resources/list")) as {
      result: {
        resources: Array<{ description?: string; mimeType: string; name: string; uri: string }>;
      };
    };
    const { resources } = body.result;

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      description: "First-line hook.",
      mimeType: "application/json",
      name: "Camo & Krooked — Test Banger",
      uri: "fluncle://finding/012.8.0A",
    });
    expect(resources[1]?.uri).toBe("fluncle://mixtape/019.F.1A");
    expect(resources[1]?.name).toContain("Fluncle — ");
  });

  it("reads a finding resource at its typed URI", async () => {
    resolveTargetMock.mockResolvedValue({ kind: "track", track: findingFixture() });

    const body = (await rpc("resources/read", { uri: "fluncle://finding/012.8.0A" })) as {
      result: { contents: Array<{ mimeType: string; text: string; uri: string }> };
    };
    const content = body.result.contents[0];

    expect(content?.uri).toBe("fluncle://finding/012.8.0A");
    expect(content?.mimeType).toBe("application/json");
    expect(JSON.parse(content?.text ?? "{}")).toMatchObject({ coordinate: "012.8.0A" });
    // The bare display form resolves to the same coordinate too.
    expect(resolveTargetMock).toHaveBeenCalledWith("012.8.0A");
  });

  it("reads the bare display URI form as well", async () => {
    resolveTargetMock.mockResolvedValue({ kind: "track", track: findingFixture() });

    await rpc("resources/read", { uri: "fluncle://012.8.0A" });

    expect(resolveTargetMock).toHaveBeenCalledWith("012.8.0A");
  });

  it("errors on a non-fluncle resource URI", async () => {
    const body = (await rpc("resources/read", { uri: "https://example.com/x" })) as {
      error?: { code: number };
    };

    expect(body.error?.code).toBe(-32602);
  });

  it("errors resource-not-found for an unknown coordinate", async () => {
    resolveTargetMock.mockResolvedValue(undefined);

    const body = (await rpc("resources/read", { uri: "fluncle://finding/999.9.9Z" })) as {
      error?: { code: number };
    };

    expect(body.error?.code).toBe(-32002);
  });
});

describe("MCP prompts", () => {
  it("lists the Fluncle-voiced prompts with their arguments", async () => {
    const body = (await rpc("prompts/list")) as {
      result: {
        prompts: Array<{
          arguments: Array<{ name: string; required: boolean }>;
          name: string;
        }>;
      };
    };
    const names = body.result.prompts.map((prompt) => prompt.name);

    expect(names).toEqual(
      expect.arrayContaining(["recommend_finding", "walk_recent_night", "decode_coordinate"]),
    );
    const recommend = body.result.prompts.find((prompt) => prompt.name === "recommend_finding");
    expect(recommend?.arguments).toEqual([
      expect.objectContaining({ name: "mood", required: true }),
    ]);
  });

  it("expands a prompt with its argument woven in", async () => {
    const body = (await rpc("prompts/get", {
      arguments: { mood: "3am, still driving" },
      name: "recommend_finding",
    })) as {
      result: { messages: Array<{ content: { text: string; type: string }; role: string }> };
    };
    const message = body.result.messages[0];

    expect(message?.role).toBe("user");
    expect(message?.content.type).toBe("text");
    expect(message?.content.text).toContain("3am, still driving");
    // It steers the agent at the read tools/resources it should use.
    expect(message?.content.text).toContain("get_track");
  });

  it("clamps the walk count and defaults it when unset", async () => {
    const body = (await rpc("prompts/get", { name: "walk_recent_night" })) as {
      result: { messages: Array<{ content: { text: string } }> };
    };

    expect(body.result.messages[0]?.content.text).toContain("5 most recent findings");
  });

  it("errors on an unknown prompt", async () => {
    const body = (await rpc("prompts/get", { name: "not_a_prompt" })) as {
      error?: { code: number };
    };

    expect(body.error?.code).toBe(-32602);
  });
});
