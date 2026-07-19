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
const listFreshMock = vi.hoisted(() => vi.fn());
// The archive-read tools PR-2 lifted onto the MCP touch these — mocked so the JSON-RPC calls stay
// hermetic (no DB, no network, no real rate-limit store).
const searchArchiveMock = vi.hoisted(() => vi.fn());
const assertRateLimitMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const getFindingsByArtistMock = vi.hoisted(() => vi.fn());
const getFindingsByLabelMock = vi.hoisted(() => vi.fn());
const getMixableTracksMock = vi.hoisted(() => vi.fn());
const getMixChainDepthMock = vi.hoisted(() => vi.fn());
const getTracksByLogIdsMock = vi.hoisted(() => vi.fn());
const getArtistBySlugMock = vi.hoisted(() => vi.fn());
const countArtistFindingsMock = vi.hoisted(() => vi.fn());
const getPublicArtistSocialsMock = vi.hoisted(() => vi.fn());
const getLabelBySlugMock = vi.hoisted(() => vi.fn());
const getConfirmedAliasNamesMock = vi.hoisted(() => vi.fn());
const getArtistNeighboursMock = vi.hoisted(() => vi.fn());
// The PR-5 catalogue browse reads (list_album/artist/label_catalogue).
const getAlbumBySlugMock = vi.hoisted(() => vi.fn());
const listCatalogueTracksByAlbumMock = vi.hoisted(() => vi.fn());
const listArtistCatalogueMock = vi.hoisted(() => vi.fn());
const listLabelCatalogueMock = vi.hoisted(() => vi.fn());

// A faithful stand-in for the deterministic slug helpers (their DB-touching sibling modules stay
// mocked): "Netsky" → "netsky", "Hospital Records" → "hospital-records".
const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

vi.mock("./status", () => ({
  getServiceStatuses: statuses,
}));

vi.mock("./log-resolver", () => ({
  resolveLogPageTarget: resolveTarget,
}));

vi.mock("./tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tracks")>()),
  getFindingsByArtist: getFindingsByArtistMock,
  getFindingsByLabel: getFindingsByLabelMock,
  getMixChainDepth: getMixChainDepthMock,
  getMixableTracks: getMixableTracksMock,
  getTracksByLogIds: getTracksByLogIdsMock,
  listCatalogueTracksByAlbum: listCatalogueTracksByAlbumMock,
  listTracks: listTracksMock,
}));

vi.mock("./albums", () => ({
  albumSlug: (name: string) => toSlug(name) || undefined,
  getAlbumBySlug: getAlbumBySlugMock,
}));
vi.mock("./catalogue-groups", () => ({
  CATALOGUE_SORT_DEFAULT: "name",
  listArtistCatalogue: listArtistCatalogueMock,
  listLabelCatalogue: listLabelCatalogueMock,
}));

vi.mock("./search", () => ({ searchArchive: searchArchiveMock }));
vi.mock("./rate-limit", () => ({ assertRateLimit: assertRateLimitMock }));
vi.mock("./artists", () => ({
  countArtistFindings: countArtistFindingsMock,
  getArtistBySlug: getArtistBySlugMock,
  getPublicArtistSocials: getPublicArtistSocialsMock,
  toArtistSlug: toSlug,
}));
vi.mock("./labels", () => ({
  getConfirmedAliasNames: getConfirmedAliasNamesMock,
  getLabelBySlug: getLabelBySlugMock,
  labelSlug: (name: string) => toSlug(name) || undefined,
}));
vi.mock("./artist-dossier", () => ({ getArtistNeighbours: getArtistNeighboursMock }));

// Partial-mock ./fresh so the constants (FRESH_TRACKS_DEFAULT/MAX) stay real for the
// list_fresh schema while its DB read is stubbed.
vi.mock("./fresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fresh")>()),
  listFreshTracks: listFreshMock,
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

describe("MCP list_fresh tool", () => {
  beforeEach(() => {
    listFreshMock.mockReset();
  });

  it("is advertised in tools/list, release-framed and never claiming Fluncle found them", async () => {
    const body = (await rpc("tools/list")) as {
      result: { tools: Array<{ description: string; name: string; title: string }> };
    };
    const tool = body.result.tools.find((candidate) => candidate.name === "list_fresh");

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Fresh releases");
    // The Found Rule: these are RELEASE dates, not found dates — the description says so
    // and never tells an assistant Fluncle "found" them.
    expect(tool?.description).toMatch(/came out|release/i);
    expect(tool?.description.toLowerCase()).toContain("do not say fluncle found");
  });

  it("returns the flat fresh payload and passes the limit through", async () => {
    listFreshMock.mockResolvedValue({
      albums: [
        { artists: ["Halogenix"], name: "Record", releaseDate: "2026-07-10", slug: "record" },
      ],
      tracks: [
        {
          artists: ["Halogenix"],
          certified: true,
          logId: "050.7.0A",
          releaseDate: "2026-07-12",
          title: "Lit",
        },
        { artists: ["Unknown"], certified: false, releaseDate: "2026-07-11", title: "Quiet" },
      ],
      windowDays: 30,
    });

    const { data, isError } = await callTool("list_fresh", { limit: 12 });

    expect(isError).toBe(false);
    expect(listFreshMock).toHaveBeenCalledWith({ limit: 12 });
    expect(data.windowDays).toBe(30);
    const tracks = data.tracks as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(2);
    // The Unlit Rule is structural: the uncertified row carries no coordinate.
    expect(tracks[0]?.logId).toBe("050.7.0A");
    expect(tracks[1]?.logId).toBeUndefined();
    expect(data.albums).toHaveLength(1);
  });

  it("passes an undefined limit through when none is given (the lib defaults it)", async () => {
    listFreshMock.mockResolvedValue({ albums: [], tracks: [], windowDays: 30 });

    await callTool("list_fresh");

    expect(listFreshMock).toHaveBeenCalledWith({ limit: undefined });
  });

  it("view=albums returns only the records; the track stream is emptied", async () => {
    listFreshMock.mockResolvedValue({
      albums: [{ artists: ["Break"], name: "Record", releaseDate: "2026-07-10", slug: "record" }],
      tracks: [
        {
          artists: ["Halogenix"],
          certified: true,
          logId: "050.7.0A",
          releaseDate: "2026-07-12",
          title: "Lit",
        },
      ],
      windowDays: 30,
    });

    const { data, isError } = await callTool("list_fresh", { view: "albums" });

    expect(isError).toBe(false);
    expect(data.albums).toHaveLength(1);
    expect(data.tracks).toHaveLength(0);
    expect(data.windowDays).toBe(30);
  });

  it("view=tracks returns only the release stream; the records are emptied", async () => {
    listFreshMock.mockResolvedValue({
      albums: [{ artists: ["Break"], name: "Record", releaseDate: "2026-07-10", slug: "record" }],
      tracks: [
        {
          artists: ["Halogenix"],
          certified: true,
          logId: "050.7.0A",
          releaseDate: "2026-07-12",
          title: "Lit",
        },
      ],
      windowDays: 30,
    });

    const { data, isError } = await callTool("list_fresh", { view: "tracks" });

    expect(isError).toBe(false);
    expect(data.tracks).toHaveLength(1);
    expect(data.albums).toHaveLength(0);
  });

  it("no view is the same as view=all — both buckets served (backwards-compatible)", async () => {
    listFreshMock.mockResolvedValue({
      albums: [{ artists: ["Break"], name: "Record", releaseDate: "2026-07-10", slug: "record" }],
      tracks: [
        {
          artists: ["Halogenix"],
          certified: true,
          logId: "050.7.0A",
          releaseDate: "2026-07-12",
          title: "Lit",
        },
      ],
      windowDays: 30,
    });

    const { data } = await callTool("list_fresh", { view: "all" });

    expect(data.albums).toHaveLength(1);
    expect(data.tracks).toHaveLength(1);
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

describe("MCP — the archive-read tools PR-2 lifted out of ChatDnB", () => {
  beforeEach(() => {
    searchArchiveMock.mockReset();
    assertRateLimitMock.mockReset();
    assertRateLimitMock.mockResolvedValue(undefined);
    getFindingsByArtistMock.mockReset();
    getFindingsByArtistMock.mockResolvedValue([]);
    getFindingsByLabelMock.mockReset();
    getFindingsByLabelMock.mockResolvedValue([]);
    getMixableTracksMock.mockReset();
    getMixableTracksMock.mockResolvedValue([]);
    getMixChainDepthMock.mockReset();
    getMixChainDepthMock.mockResolvedValue({ median: 40, open: true, rankable: 100 });
    getTracksByLogIdsMock.mockReset();
    getTracksByLogIdsMock.mockResolvedValue({});
    getArtistBySlugMock.mockReset();
    getArtistBySlugMock.mockResolvedValue(undefined);
    countArtistFindingsMock.mockReset();
    countArtistFindingsMock.mockResolvedValue(0);
    getPublicArtistSocialsMock.mockReset();
    getPublicArtistSocialsMock.mockResolvedValue([]);
    getLabelBySlugMock.mockReset();
    getLabelBySlugMock.mockResolvedValue(undefined);
    getConfirmedAliasNamesMock.mockReset();
    getConfirmedAliasNamesMock.mockResolvedValue([]);
    getArtistNeighboursMock.mockReset();
    getArtistNeighboursMock.mockResolvedValue([]);
    getAlbumBySlugMock.mockReset();
    getAlbumBySlugMock.mockResolvedValue(undefined);
    listCatalogueTracksByAlbumMock.mockReset();
    listCatalogueTracksByAlbumMock.mockResolvedValue({ total: 0, tracks: [] });
    listArtistCatalogueMock.mockReset();
    listArtistCatalogueMock.mockResolvedValue({
      groups: [],
      page: 1,
      pageCount: 1,
      totalGroups: 0,
      totalTracks: 0,
    });
    listLabelCatalogueMock.mockReset();
    listLabelCatalogueMock.mockResolvedValue({
      groups: [],
      page: 1,
      pageCount: 1,
      totalGroups: 0,
      totalTracks: 0,
    });
    resolveTargetMock.mockReset();
  });

  it("advertises every newly-migrated tool in tools/list", async () => {
    const body = (await rpc("tools/list")) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((tool) => tool.name);

    for (const name of [
      "search_archive",
      "get_artist",
      "get_label",
      "build_set",
      "get_similar_artists",
      // The three catalogue browse reads (PR-5).
      "list_album_catalogue",
      "list_artist_catalogue",
      "list_label_catalogue",
      // The two writes moved onto the shared registry — still advertised on the MCP.
      "submit_track",
      "subscribe_newsletter",
    ]) {
      expect(names, `${name} advertised`).toContain(name);
    }
  });

  it("list_album_catalogue world-serves the flat catalogue list, each row certified-tagged", async () => {
    getAlbumBySlugMock.mockResolvedValue({ id: "alb-1", name: "Colours", slug: "colours" });
    listCatalogueTracksByAlbumMock.mockResolvedValue({
      total: 1,
      tracks: [
        {
          artists: ["Netsky"],
          spotifyUrl: "https://open.spotify.com/track/a",
          title: "Iron Heart",
          trackId: "a",
        },
      ],
    });

    const { data, isError } = await callTool("list_album_catalogue", { name: "Colours" });

    expect(isError).toBe(false);
    expect(getAlbumBySlugMock).toHaveBeenCalledWith("colours");
    // The MCP world-serves a FLAT catalogue list (never a findings bucket); every row is tagged
    // certified:false and carries no coordinate — an agent reads them as records, not findings.
    const catalogue = data.catalogue as Array<Record<string, unknown>>;
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]).toMatchObject({
      certified: false,
      release: "Colours",
      title: "Iron Heart",
    });
    expect(catalogue[0]?.coordinate).toBeUndefined();
  });

  it("list_artist_catalogue returns an empty catalogue for an unlogged name (never an error)", async () => {
    getArtistBySlugMock.mockResolvedValue(undefined);

    const { data, isError } = await callTool("list_artist_catalogue", { name: "Nobody" });

    expect(isError).toBe(false);
    expect(data.catalogue).toEqual([]);
    expect(listArtistCatalogueMock).not.toHaveBeenCalled();
  });

  it("search_archive RATE-LIMITS (shared budget) and world-serves BOTH registers, certified-tagged", async () => {
    searchArchiveMock.mockResolvedValue({
      degraded: false,
      entities: [],
      kind: "token",
      results: [
        {
          artists: ["Nu:Tone"],
          certified: true,
          logId: "004.7.2I",
          title: "Better Places",
          trackId: "a",
        },
        { artists: ["Someone"], certified: false, title: "A Catalogue Cut", trackId: "b" },
      ],
    });

    const { data, isError } = await callTool("search_archive", { query: "nu:tone" });

    expect(isError).toBe(false);
    // 🔴 MANDATORY: the anonymous /mcp shares the public HTTP twin's per-IP budget.
    expect(assertRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "search_archive", limit: 30 }),
    );
    // Unlike chat's findings-only filter, the MCP serves the WHOLE SearchResult — the uncertified
    // row rides too, tagged certified:false (never findings-filtered).
    const results = data.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ certified: true, logId: "004.7.2I" });
    expect(results[1]).toMatchObject({ certified: false, title: "A Catalogue Cut" });
    expect(results[1]?.logId).toBeUndefined();
  });

  it("get_artist reads an artist's dossier by name", async () => {
    getArtistBySlugMock.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    countArtistFindingsMock.mockResolvedValue(1);
    getFindingsByArtistMock.mockResolvedValue([
      { artists: ["Netsky"], logId: "004.7.2I", title: "Rio" },
    ]);

    const { data, isError } = await callTool("get_artist", { name: "Netsky" });

    expect(isError).toBe(false);
    const artist = data.artist as Record<string, unknown>;
    expect(artist).toMatchObject({ findingCount: 1, name: "Netsky", slug: "netsky" });
  });

  it("get_label reads a label's dossier by name", async () => {
    getLabelBySlugMock.mockResolvedValue({
      id: "lbl-1",
      logoImageUrl: undefined,
      name: "Hospital Records",
      slug: "hospital-records",
    });
    getFindingsByLabelMock.mockResolvedValue([
      { artists: ["Nu:Tone"], logId: "004.7.2I", title: "Better Places" },
    ]);

    const { data, isError } = await callTool("get_label", { name: "Hospital Records" });

    expect(isError).toBe(false);
    const label = data.label as Record<string, unknown>;
    expect(label).toMatchObject({ name: "Hospital Records", slug: "hospital-records" });
  });

  it("build_set chains a set from a coordinate seed", async () => {
    resolveTargetMock.mockResolvedValue({
      kind: "track",
      track: {
        artists: ["Seed"],
        durationMs: 200_000,
        logId: "004.7.2I",
        title: "Seed",
        trackId: "s",
      },
    });
    getMixableTracksMock.mockResolvedValue([]);

    const { data, isError } = await callTool("build_set", { seed: "004.7.2I" });

    expect(isError).toBe(false);
    const set = data.set as { seed: { coordinate?: string } };
    expect(set.seed.coordinate).toBe("004.7.2I");
  });

  it("get_similar_artists returns the nearest artists by name", async () => {
    getArtistBySlugMock.mockResolvedValue({ id: "art-1", name: "Koven", slug: "koven" });
    getArtistNeighboursMock.mockResolvedValue([
      { name: "Camo & Krooked", slug: "camo-krooked" },
      { name: "Metrik", slug: "metrik" },
    ]);

    const { data, isError } = await callTool("get_similar_artists", { name: "Koven" });

    expect(isError).toBe(false);
    expect(getArtistNeighboursMock).toHaveBeenCalledWith("art-1", expect.any(Number));
    const similar = data.similar as Array<{ slug: string }>;
    expect(similar.map((artist) => artist.slug)).toEqual(["camo-krooked", "metrik"]);
  });

  it("get_similar_artists returns found:false for an unlogged name", async () => {
    getArtistBySlugMock.mockResolvedValue(undefined);

    const { data } = await callTool("get_similar_artists", { name: "Nobody" });

    expect(data.found).toBe(false);
    expect(getArtistNeighboursMock).not.toHaveBeenCalled();
  });
});
