import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readOptionalEnv = vi.hoisted(() => vi.fn<(name: string) => Promise<string | undefined>>());
const getTracksByLogIds = vi.hoisted(() =>
  vi.fn<(logIds: string[]) => Promise<Record<string, unknown>>>(),
);
const getFindingsByArtist = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const getFindingsByLabel = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const getMixableTracks = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const getMixChainDepth = vi.hoisted(() =>
  vi.fn<() => Promise<{ median: number; open: boolean; rankable: number }>>(),
);
const toArtistSlug = vi.hoisted(() => vi.fn<(name: string) => string>());
const getPublicArtistBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
const getPublicArtistSocials = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const countArtistFindings = vi.hoisted(() => vi.fn<() => Promise<number>>());
const labelSlug = vi.hoisted(() => vi.fn<(name: string) => string | undefined>());
const getLabelBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
const getConfirmedAliasNames = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
const listFreshTracks = vi.hoisted(() =>
  vi.fn<() => Promise<{ albums: unknown[]; tracks: unknown[]; windowDays: number }>>(),
);
const getArtistNeighbours = vi.hoisted(() =>
  vi.fn<() => Promise<Array<{ imageUrl?: string; name: string; slug: string }>>>(),
);

const getAlbumBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
const listCatalogueTracksByAlbum = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const listArtistCatalogue = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const listLabelCatalogue = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const hasPublicGraphTracks = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./fresh", () => ({ listFreshTracks }));
vi.mock("./artist-dossier", () => ({ getArtistNeighbours }));
vi.mock("./search", () => ({ searchArchive: vi.fn() }));
vi.mock("./log-resolver", () => ({ resolveLogPageTarget: vi.fn() }));
vi.mock("./status", () => ({ getServiceStatuses: vi.fn() }));
vi.mock("./artists", () => ({
  countArtistFindings,
  getPublicArtistBySlug,
  getPublicArtistSocials,
  toArtistSlug,
}));
vi.mock("./labels", () => ({
  getConfirmedAliasNames,
  getLabelBySlug,
  labelSlug,
}));
vi.mock("./tracks", () => ({
  getFindingsByArtist,
  getFindingsByLabel,
  getMixChainDepth,
  getMixableTracks,
  getRandomTrack: vi.fn(),
  getTracksByLogIds,
  listCatalogueTracksByAlbum,
  listTracks: vi.fn(),
  toPublicTrackListItem: (item: unknown) => item,
}));
vi.mock("./albums", () => ({
  albumSlug: (name: string) => toSlug(name) || undefined,
  getAlbumBySlug,
}));
vi.mock("./catalogue-groups", () => ({
  CATALOGUE_SORT_DEFAULT: "name",
  listArtistCatalogue,
  listLabelCatalogue,
}));
vi.mock("./hub-counts", () => ({ hasPublicGraphTracks }));

import {
  buildChatTools,
  FLUNCLE_CHAT_SYSTEM_PROMPT,
  type FluncleUIMessage,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_TOTAL_CHARS,
  MAX_PARTS_PER_MESSAGE,
  MAX_TEXT_PART_CHARS,
  parseChatRequest,
  resolveChatModel,
  streamChat,
} from "./chat";

beforeEach(() => {
  hasPublicGraphTracks.mockReset();
  hasPublicGraphTracks.mockResolvedValue(true);
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue(undefined);
  getTracksByLogIds.mockReset();

  getTracksByLogIds.mockResolvedValue({});

  getFindingsByArtist.mockReset();
  getFindingsByArtist.mockResolvedValue([]);
  getFindingsByLabel.mockReset();
  getFindingsByLabel.mockResolvedValue([]);

  getMixableTracks.mockReset();
  getMixableTracks.mockResolvedValue([]);
  getMixChainDepth.mockReset();
  getMixChainDepth.mockResolvedValue({ median: 40, open: true, rankable: 100 });
  toArtistSlug.mockReset();
  toArtistSlug.mockImplementation(toSlug);
  getPublicArtistBySlug.mockReset();
  getPublicArtistBySlug.mockResolvedValue(undefined);
  getPublicArtistSocials.mockReset();
  getPublicArtistSocials.mockResolvedValue([]);
  countArtistFindings.mockReset();
  countArtistFindings.mockResolvedValue(0);
  labelSlug.mockReset();
  labelSlug.mockImplementation((name: string) => toSlug(name) || undefined);
  getLabelBySlug.mockReset();
  getLabelBySlug.mockResolvedValue(undefined);
  getConfirmedAliasNames.mockReset();
  getConfirmedAliasNames.mockResolvedValue([]);

  listFreshTracks.mockReset();
  listFreshTracks.mockResolvedValue({ albums: [], tracks: [], windowDays: 30 });

  getArtistNeighbours.mockReset();
  getArtistNeighbours.mockResolvedValue([]);

  getAlbumBySlug.mockReset();
  getAlbumBySlug.mockResolvedValue(undefined);
  listCatalogueTracksByAlbum.mockReset();
  listCatalogueTracksByAlbum.mockResolvedValue({ total: 0, tracks: [] });
  listArtistCatalogue.mockReset();
  listArtistCatalogue.mockResolvedValue({
    groups: [],
    page: 1,
    pageCount: 1,
    totalGroups: 0,
    totalTracks: 0,
  });
  listLabelCatalogue.mockReset();
  listLabelCatalogue.mockResolvedValue({
    groups: [],
    page: 1,
    pageCount: 1,
    totalGroups: 0,
    totalTracks: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FLUNCLE_CHAT_SYSTEM_PROMPT — the grounding rule is the product", () => {
  it("mandates answering only from the tools and refusing to invent", () => {
    const prompt = FLUNCLE_CHAT_SYSTEM_PROMPT.toLowerCase();

    expect(prompt).toContain("from the archive or you do not answer");
    expect(prompt).toContain("must come from a tool result");
    expect(prompt).toContain("never invent");

    expect(prompt).toContain("certified");
    expect(prompt).toContain("catalogue row");

    expect(prompt).toContain("any name for the tier");

    expect(FLUNCLE_CHAT_SYSTEM_PROMPT).toContain("No exclamation marks");

    expect(FLUNCLE_CHAT_SYSTEM_PROMPT).not.toContain("!");
  });
});

describe("parseChatRequest", () => {
  it("accepts a well-formed UIMessage turn history", () => {
    const messages = [
      {
        id: "msg-1",
        parts: [{ text: "what's on Hospital?", type: "text" }],
        role: "user",
      },
      {
        id: "msg-2",
        parts: [{ text: "let me dig", type: "text" }],
        role: "assistant",
      },
    ];

    expect(parseChatRequest({ messages })).toEqual(messages);
  });

  it("rejects malformed bodies", () => {
    expect(parseChatRequest({ messages: [] })).toBeNull();
    expect(
      parseChatRequest({
        messages: [{ id: "m", parts: [{ text: "hi", type: "text" }], role: "system" }],
      }),
    ).toBeNull();
    expect(parseChatRequest({ messages: [{ id: "m", role: "user" }] })).toBeNull();
    expect(parseChatRequest({ messages: "nope" })).toBeNull();
    expect(parseChatRequest({})).toBeNull();
    expect(parseChatRequest("nope")).toBeNull();
  });

  function textMessage(text: string, index = 0) {
    return { id: `msg-${index}`, parts: [{ text, type: "text" }], role: "user" as const };
  }

  it("accepts a history AT the message cap and rejects one message more", () => {
    const atCap = Array.from({ length: MAX_CHAT_MESSAGES }, (_, i) => textMessage("hi", i));

    expect(parseChatRequest({ messages: atCap })).toHaveLength(MAX_CHAT_MESSAGES);
    expect(
      parseChatRequest({ messages: [...atCap, textMessage("hi", MAX_CHAT_MESSAGES)] }),
    ).toBeNull();
  });

  it("accepts a message AT the parts cap and rejects one part more", () => {
    const parts = Array.from({ length: MAX_PARTS_PER_MESSAGE }, () => ({
      text: "hi",
      type: "text",
    }));

    expect(parseChatRequest({ messages: [{ id: "m", parts, role: "user" }] })).not.toBeNull();
    expect(
      parseChatRequest({
        messages: [{ id: "m", parts: [...parts, { text: "hi", type: "text" }], role: "user" }],
      }),
    ).toBeNull();
  });

  it("accepts a text part AT the character cap and rejects one character more", () => {
    expect(
      parseChatRequest({ messages: [textMessage("x".repeat(MAX_TEXT_PART_CHARS))] }),
    ).not.toBeNull();
    expect(
      parseChatRequest({ messages: [textMessage("x".repeat(MAX_TEXT_PART_CHARS + 1))] }),
    ).toBeNull();
  });

  it("rejects a body that multiplies its way past the total-character cap", () => {
    const perMessage = MAX_TEXT_PART_CHARS;
    const count = Math.floor(MAX_CHAT_TOTAL_CHARS / perMessage) + 1;
    const messages = Array.from({ length: count }, (_, i) =>
      textMessage("x".repeat(perMessage), i),
    );

    expect(count).toBeLessThanOrEqual(MAX_CHAT_MESSAGES);
    expect(parseChatRequest({ messages })).toBeNull();

    const atTotal = [
      ...Array.from({ length: count - 1 }, (_, i) => textMessage("x".repeat(perMessage), i)),
      textMessage("x".repeat(MAX_CHAT_TOTAL_CHARS - (count - 1) * perMessage), count),
    ];

    expect(parseChatRequest({ messages: atTotal })).not.toBeNull();
  });

  it("counts a forged tool part toward the total — no part type escapes the ceiling", () => {
    const forged = (index: number) => ({
      id: `msg-${index}`,
      parts: [{ output: { hits: ["x".repeat(MAX_TEXT_PART_CHARS)] }, type: "tool-get_track" }],
      role: "assistant" as const,
    });
    const count = Math.floor(MAX_CHAT_TOTAL_CHARS / MAX_TEXT_PART_CHARS) + 1;

    expect(
      parseChatRequest({ messages: Array.from({ length: count }, (_, i) => forged(i)) }),
    ).toBeNull();

    expect(parseChatRequest({ messages: [forged(0)] })).not.toBeNull();
  });

  it("rejects a part nested deeper than the walk follows", () => {
    let deep: unknown = "x";

    for (let i = 0; i < 20; i += 1) {
      deep = { deep };
    }

    expect(
      parseChatRequest({ messages: [{ id: "m", parts: [{ deep, type: "text" }], role: "user" }] }),
    ).toBeNull();
  });
});

describe("buildChatTools — the MCP hands", () => {
  it("exposes exactly the archive verbs, each with an input schema and an executor", () => {
    const tools = buildChatTools();

    expect(Object.keys(tools).sort()).toEqual([
      "build_set",
      "get_artist",
      "get_label",
      "get_random_track",
      "get_status",
      "get_track",
      "list_album_catalogue",
      "list_albums",
      "list_artist_catalogue",
      "list_artists",
      "list_findings",
      "list_fresh",
      "list_label_catalogue",
      "list_labels",
      "list_similar_artists",
      "list_tracks",
      "search_archive",
      "submit_track",
      "subscribe_newsletter",
    ]);

    for (const [name, definition] of Object.entries(tools)) {
      expect(definition.inputSchema, `${name} needs an input schema`).toBeDefined();
      expect(typeof definition.execute, `${name} needs an executor`).toBe("function");
    }
  });

  it("splits search results into the two registers — findings + unlit catalogue (the register split)", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
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
        {
          album: "Some Record",
          artists: ["Someone"],
          bpm: 174,
          certified: false,
          key: "F minor",
          label: "Some Label",
          spotifyUrl: "https://open.spotify.com/track/uncert",
          title: "An Uncertified Cut",
          trackId: "b",
        },
      ],
    } as never);

    const tools = buildChatTools();
    const execute = tools.search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    const result = (await execute({ query: "nu:tone" }, {} as never)) as {
      catalogue: Record<string, unknown>[];
      findings: { coordinate?: string; title: string }[];
    };

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Better Places");
    expect(result.findings[0]?.coordinate).toBe("004.7.2I");

    expect(result.catalogue).toHaveLength(1);
    const row = result.catalogue[0] ?? {};
    expect(row.title).toBe("An Uncertified Cut");
    expect(row.artists).toEqual(["Someone"]);
    expect(row.spotifyUrl).toBe("https://open.spotify.com/track/uncert");
    expect(row.release).toBe("Some Record");
    expect(row.label).toBe("Some Label");
    for (const lit of [
      "coordinate",
      "logId",
      "note",
      "observation",
      "bpm",
      "key",
      "albumImageUrl",
      "hasPreview",
      "galaxy",
    ]) {
      expect(row, `catalogue row must not carry ${lit}`).not.toHaveProperty(lit);
    }
  });

  it("hydrates search findings with cover, duration, and a hasPreview flag (the card fields)", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
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
      ],
    } as never);

    getTracksByLogIds.mockResolvedValue({
      "004.7.2I": {
        addedAt: "2026-01-01",
        albumImageUrl: "https://cover.example/better-places.jpg",
        artists: ["Nu:Tone"],
        bpm: 174,
        durationMs: 210_000,
        key: "F minor",
        logId: "004.7.2I",
        previewUrl: "https://deezer.example/expiring-token.mp3",
        title: "Better Places",
      },
    });

    const tools = buildChatTools();
    const execute = tools.search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    const result = (await execute({ query: "nu:tone" }, {} as never)) as {
      findings: { albumImageUrl?: string; durationMs?: number; hasPreview?: boolean }[];
    };

    expect(result.findings[0]?.albumImageUrl).toBe("https://cover.example/better-places.jpg");
    expect(result.findings[0]?.durationMs).toBe(210_000);
    expect(result.findings[0]?.hasPreview).toBe(true);
  });

  it("never leaks a previewUrl onto any tool output (the expiring token stays server-side)", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
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
      ],
    } as never);

    getTracksByLogIds.mockResolvedValue({
      "004.7.2I": {
        addedAt: "2026-01-01",
        albumImageUrl: "https://cover.example/better-places.jpg",
        artists: ["Nu:Tone"],
        durationMs: 210_000,
        logId: "004.7.2I",
        previewUrl: "https://deezer.example/expiring-token.mp3",
        title: "Better Places",
      },
    });

    const tools = buildChatTools();
    const execute = tools.search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    const result = await execute({ query: "nu:tone" }, {} as never);

    expect(hasKeyDeep(result, "previewUrl")).toBe(false);
  });

  it("applies the certified filter BEFORE the hydrator (no uncertified logId is looked up)", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
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
        {
          artists: ["Someone"],
          certified: false,

          logId: "999.9.9Z",
          title: "An Uncertified Cut",
          trackId: "b",
        },
      ],
    } as never);

    const tools = buildChatTools();
    const execute = tools.search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    await execute({ query: "nu:tone" }, {} as never);

    expect(getTracksByLogIds).toHaveBeenCalledTimes(1);
    const lookedUp = getTracksByLogIds.mock.calls[0]?.[0] ?? [];
    expect(lookedUp).toContain("004.7.2I");
    expect(lookedUp).not.toContain("999.9.9Z");
  });

  it("splits the fresh list into findings + unlit catalogue (fixes the empty-in-chat bug)", async () => {
    listFreshTracks.mockResolvedValue({
      albums: [],
      tracks: [
        {
          artists: ["Nu:Tone"],
          certified: true,
          coverImageUrl: "https://cover.example/better-places.jpg",
          logId: "004.7.2I",
          releaseDate: "2026-07-15",
          title: "Better Places",
        },
        {
          artists: ["Someone"],
          certified: false,

          logId: "999.9.9Z",
          releaseDate: "2026-07-16",
          spotifyUrl: "https://open.spotify.com/track/uncert",
          title: "An Uncertified Cut",
        },
      ],
      windowDays: 30,
    });

    const tools = buildChatTools();
    const execute = tools.list_fresh?.execute;
    if (typeof execute !== "function") {
      throw new Error("list_fresh executor missing");
    }

    const result = (await execute({}, {} as never)) as {
      catalogue: Record<string, unknown>[];
      findings: { coordinate?: string; title: string }[];
    };

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Better Places");
    expect(result.findings[0]?.coordinate).toBe("004.7.2I");

    expect((result.findings[0] as { releaseDate?: string }).releaseDate).toBe("2026-07-15");

    expect(result.catalogue).toHaveLength(1);
    const row = result.catalogue[0] ?? {};
    expect(row.title).toBe("An Uncertified Cut");
    expect(row.spotifyUrl).toBe("https://open.spotify.com/track/uncert");

    expect(row.releaseDate).toBe("2026-07-16");
    for (const lit of ["coordinate", "logId", "note", "observation", "bpm", "key", "hasPreview"]) {
      expect(row, `catalogue row must not carry ${lit}`).not.toHaveProperty(lit);
    }

    const lookedUp = getTracksByLogIds.mock.calls.at(-1)?.[0] ?? [];
    expect(lookedUp).toContain("004.7.2I");
    expect(lookedUp).not.toContain("999.9.9Z");
  });

  it("carries the release date on a HYDRATED certified finding (the common path, not just the fallback)", async () => {
    listFreshTracks.mockResolvedValue({
      albums: [],
      tracks: [
        {
          artists: ["Nu:Tone"],
          certified: true,
          coverImageUrl: "https://cover.example/bp.jpg",
          logId: "004.7.2I",
          releaseDate: "2026-07-15",
          title: "Better Places",
        },
      ],
      windowDays: 30,
    });

    getTracksByLogIds.mockResolvedValue({
      "004.7.2I": {
        artists: ["Nu:Tone"],
        logId: "004.7.2I",
        title: "Better Places",
        trackId: "a",
      },
    });

    const tools = buildChatTools();
    const execute = tools.list_fresh?.execute;
    if (typeof execute !== "function") {
      throw new Error("list_fresh executor missing");
    }

    const result = (await execute({}, {} as never)) as {
      findings: { coordinate?: string; releaseDate?: string; title: string }[];
    };

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.coordinate).toBe("004.7.2I");
    expect(result.findings[0]?.releaseDate).toBe("2026-07-15");
  });

  it("view=albums surfaces the records as unlit catalogue rows — reused shape, no coordinate", async () => {
    listFreshTracks.mockResolvedValue({
      albums: [
        {
          artists: ["Break", "Kyo"],
          name: "Simpler Times",
          releaseDate: "2026-07-18",
          slug: "simpler-times",
        },
      ],
      tracks: [
        {
          artists: ["Nu:Tone"],
          certified: true,
          coverImageUrl: "https://cover.example/bp.jpg",
          logId: "004.7.2I",
          releaseDate: "2026-07-15",
          title: "Better Places",
        },
      ],
      windowDays: 30,
    });

    const tools = buildChatTools();
    const execute = tools.list_fresh?.execute;
    if (typeof execute !== "function") {
      throw new Error("list_fresh executor missing");
    }

    const result = (await execute({ view: "albums" }, {} as never)) as {
      catalogue?: Record<string, unknown>[];
      findings?: unknown[];
    };

    expect(result.findings).toBeUndefined();
    expect(result.catalogue).toHaveLength(1);
    const row = result.catalogue?.[0] ?? {};
    expect(row.title).toBe("Simpler Times");
    expect(row.artists).toEqual(["Break", "Kyo"]);

    for (const lit of ["coordinate", "logId", "spotifyUrl", "note", "bpm", "key"]) {
      expect(row, `record row must not carry ${lit}`).not.toHaveProperty(lit);
    }
  });

  it("exposes the two WRITE verbs on chat, each with an input schema + executor", () => {
    const tools = buildChatTools();

    for (const name of ["submit_track", "subscribe_newsletter"] as const) {
      expect(tools[name]?.inputSchema, `${name} needs a schema`).toBeDefined();
      expect(typeof tools[name]?.execute, `${name} needs an executor`).toBe("function");
    }
  });
});

describe("list_similar_artists — the artist-discovery read", () => {
  function similarExecutor() {
    const execute = buildChatTools().list_similar_artists?.execute;

    if (typeof execute !== "function") {
      throw new Error("list_similar_artists executor missing");
    }

    return execute;
  }

  it("resolves a NAME through the slug helper and passes the artist id to getArtistNeighbours", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "art-1", name: "Koven", slug: "koven" });
    getArtistNeighbours.mockResolvedValue([
      { imageUrl: "https://cover.example/a.jpg", name: "Camo & Krooked", slug: "camo-krooked" },
      { name: "Metrik", slug: "metrik" },
    ]);

    const result = (await similarExecutor()({ name: "Koven" }, {} as never)) as {
      of: { name?: string; slug?: string };
      similar: { name: string; slug: string }[];
    };

    expect(toArtistSlug).toHaveBeenCalledWith("Koven");
    expect(getPublicArtistBySlug).toHaveBeenCalledWith("koven");

    expect(getArtistNeighbours).toHaveBeenCalledWith("art-1", expect.any(Number));
    expect(result.of).toEqual({ name: "Koven", slug: "koven" });
    expect(result.similar.map((artist) => artist.slug)).toEqual(["camo-krooked", "metrik"]);
  });

  it("returns found:false when the name resolves to no artist he has logged", async () => {
    getPublicArtistBySlug.mockResolvedValue(undefined);

    const result = await similarExecutor()({ name: "Nobody At All" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
    expect(getArtistNeighbours).not.toHaveBeenCalled();
  });

  it("returns an honest empty list when the artist has no neighbours yet (not found:false)", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "art-2", name: "Quiet One", slug: "quiet-one" });
    getArtistNeighbours.mockResolvedValue([]);

    const result = (await similarExecutor()({ name: "Quiet One" }, {} as never)) as {
      ok: boolean;
      similar: unknown[];
    };

    expect(result.ok).toBe(true);
    expect(result.similar).toEqual([]);
  });
});

describe("the catalogue browse tools — name → the unlit catalogue bucket (PR-5)", () => {
  function browseExecutor(
    name: "list_album_catalogue" | "list_artist_catalogue" | "list_label_catalogue",
  ) {
    const execute = buildChatTools()[name]?.execute;

    if (typeof execute !== "function") {
      throw new Error(`${name} executor missing`);
    }

    return execute;
  }

  it("list_album_catalogue resolves a NAME and returns a catalogue-only two-bucket", async () => {
    getAlbumBySlug.mockResolvedValue({ id: "alb-1", name: "Colours", slug: "colours" });
    listCatalogueTracksByAlbum.mockResolvedValue({
      total: 2,
      tracks: [
        {
          artists: ["Netsky"],
          spotifyUrl: "https://open.spotify.com/track/a",
          title: "Iron Heart",
          trackId: "a",
        },
        { artists: ["Netsky"], title: "Come Alive", trackId: "b" },
      ],
    });

    const result = (await browseExecutor("list_album_catalogue")(
      { name: "Colours" },
      {} as never,
    )) as {
      catalogue: Array<Record<string, unknown>>;
      findings: unknown[];
      ok: boolean;
    };

    expect(getAlbumBySlug).toHaveBeenCalledWith("colours");
    expect(listCatalogueTracksByAlbum).toHaveBeenCalledWith("alb-1");

    expect(result).toMatchObject({ ok: true });
    expect(result.findings).toEqual([]);
    expect(result.catalogue).toHaveLength(2);
    expect(result.catalogue[0]).toMatchObject({
      artists: ["Netsky"],
      release: "Colours",
      spotifyUrl: "https://open.spotify.com/track/a",
      title: "Iron Heart",
    });
    for (const row of result.catalogue) {
      for (const lit of ["coordinate", "note", "bpm", "key", "albumImageUrl", "hasPreview"]) {
        expect(row[lit], `catalogue row leaks ${lit}`).toBeUndefined();
      }
    }
  });

  it("list_artist_catalogue flattens the grouped page into catalogue rows", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "art-9", name: "Netsky", slug: "netsky" });
    listArtistCatalogue.mockResolvedValue({
      groups: [
        {
          name: "Colours",
          releaseDate: "2012-06-04",
          slug: "colours",
          tracks: [{ artists: ["Netsky"], title: "Iron Heart", trackId: "a" }],
        },
      ],
      page: 1,
      pageCount: 1,
      totalGroups: 1,
      totalTracks: 1,
    });

    const result = (await browseExecutor("list_artist_catalogue")(
      { name: "Netsky" },
      {} as never,
    )) as {
      catalogue: Array<Record<string, unknown>>;
      findings: unknown[];
    };

    expect(getPublicArtistBySlug).toHaveBeenCalledWith("netsky");
    expect(listArtistCatalogue).toHaveBeenCalledWith("art-9", "name", 1);
    expect(result.findings).toEqual([]);
    expect(result.catalogue).toEqual([
      { artists: ["Netsky"], release: "Colours", title: "Iron Heart" },
    ]);
  });

  it("list_label_catalogue flattens the artist→record grouping and carries the label as context", async () => {
    getLabelBySlug.mockResolvedValue({
      id: "lbl-9",
      name: "Hospital Records",
      slug: "hospital-records",
    });
    listLabelCatalogue.mockResolvedValue({
      groups: [
        {
          name: "Netsky",
          recordCount: 1,
          records: [
            {
              name: "Colours",
              releaseDate: undefined,
              slug: "colours",
              tracks: [{ artists: ["Netsky"], title: "Iron Heart", trackId: "a" }],
            },
          ],
          slug: "netsky",
          truncated: false,
        },
      ],
      page: 1,
      pageCount: 1,
      totalGroups: 1,
      totalTracks: 1,
    });

    const result = (await browseExecutor("list_label_catalogue")(
      { name: "Hospital Records" },
      {} as never,
    )) as {
      catalogue: Array<Record<string, unknown>>;
    };

    expect(getLabelBySlug).toHaveBeenCalledWith("hospital-records");
    expect(listLabelCatalogue).toHaveBeenCalledWith("lbl-9", "name", 1);
    expect(result.catalogue).toEqual([
      { artists: ["Netsky"], label: "Hospital Records", release: "Colours", title: "Iron Heart" },
    ]);
  });

  it("an unresolved name is the honest empty catalogue bucket, never an error", async () => {
    getAlbumBySlug.mockResolvedValue(undefined);
    getPublicArtistBySlug.mockResolvedValue(undefined);
    getLabelBySlug.mockResolvedValue(undefined);

    for (const name of [
      "list_album_catalogue",
      "list_artist_catalogue",
      "list_label_catalogue",
    ] as const) {
      const result = await browseExecutor(name)({ name: "Nothing Of His" }, {} as never);

      expect(result, name).toEqual({
        catalogue: [],
        findings: [],
        ok: true,
        page: 1,
        pageCount: 1,
      });
    }

    expect(listCatalogueTracksByAlbum).not.toHaveBeenCalled();
    expect(listArtistCatalogue).not.toHaveBeenCalled();
    expect(listLabelCatalogue).not.toHaveBeenCalled();
  });
});

describe("get_artist / get_label — the entity cards' grounding", () => {
  function artistExecutor() {
    const execute = buildChatTools().get_artist?.execute;

    if (typeof execute !== "function") {
      throw new Error("get_artist executor missing");
    }

    return execute;
  }

  function labelExecutor() {
    const execute = buildChatTools().get_label?.execute;

    if (typeof execute !== "function") {
      throw new Error("get_label executor missing");
    }

    return execute;
  }

  it("get_artist resolves a NAME through the slug helper and returns the artist's findings", async () => {
    getPublicArtistBySlug.mockResolvedValue({
      id: "art-1",
      name: "Netsky",
      slug: "netsky",
      spotifyUrl: "https://open.spotify.com/artist/x",
    });
    countArtistFindings.mockResolvedValue(2);
    getFindingsByArtist.mockResolvedValue([
      {
        albumImageUrl: "https://cover.example/rio.jpg",
        artists: ["Netsky"],
        logId: "004.7.2I",
        title: "Rio",
      },
      { artists: ["Netsky"], logId: "005.1.3B", title: "Come Alive" },
    ]);
    getPublicArtistSocials.mockResolvedValue([
      { platform: "spotify", url: "https://open.spotify.com/artist/x" },
    ]);

    const result = (await artistExecutor()({ name: "Netsky" }, {} as never)) as {
      artist: {
        avatarUrl?: string;
        findingCount?: number;
        findings: { coordinate?: string }[];
        slug?: string;
        socials?: { platform: string }[];
      };
    };

    expect(toArtistSlug).toHaveBeenCalledWith("Netsky");
    expect(getPublicArtistBySlug).toHaveBeenCalledWith("netsky");
    expect(result.artist.slug).toBe("netsky");
    expect(result.artist.findingCount).toBe(2);
    expect(result.artist.findings.map((finding) => finding.coordinate)).toEqual([
      "004.7.2I",
      "005.1.3B",
    ]);

    expect(result.artist.avatarUrl).toBe("https://cover.example/rio.jpg");
    expect(result.artist.socials).toEqual([
      { platform: "spotify", url: "https://open.spotify.com/artist/x" },
    ]);
  });

  it("get_artist returns found:false when the name resolves to no artist he has logged", async () => {
    getPublicArtistBySlug.mockResolvedValue(undefined);

    const result = await artistExecutor()({ name: "Nobody At All" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
  });

  it("get_artist returns the UNLIT entity (name + catalogue, no findings) for a catalogue-only artist", async () => {
    getPublicArtistBySlug.mockResolvedValue({
      bio: "A quiet one from the far sectors.",
      id: "art-2",
      name: "Quiet One",
      slug: "quiet-one",
      spotifyUrl: "https://open.spotify.com/artist/q",
    });
    countArtistFindings.mockResolvedValue(0);
    getFindingsByArtist.mockResolvedValue([]);
    getPublicArtistSocials.mockResolvedValue([
      { platform: "spotify", url: "https://open.spotify.com/artist/q" },
    ]);
    listArtistCatalogue.mockResolvedValue({
      groups: [
        {
          name: "Far Sectors EP",
          tracks: [
            {
              artists: ["Quiet One"],
              spotifyUrl: "https://open.spotify.com/track/z",
              title: "Drift",
            },
          ],
        },
      ],
      page: 1,
      pageCount: 1,
      totalGroups: 1,
      totalTracks: 1,
    });

    const result = (await artistExecutor()({ name: "Quiet One" }, {} as never)) as {
      artist: {
        bio?: string;
        catalogue?: { release?: string; title: string }[];
        findings?: unknown[];
        name?: string;
        slug?: string;
        socials?: { platform: string }[];
      };
    };

    expect(result.artist).toBeDefined();
    expect(result.artist.name).toBe("Quiet One");
    expect(result.artist.slug).toBe("quiet-one");

    expect(listArtistCatalogue).toHaveBeenCalledWith("art-2", "name", 1);
    expect(result.artist.catalogue).toHaveLength(1);
    const row = result.artist.catalogue?.[0];
    expect(row?.title).toBe("Drift");
    expect(row?.release).toBe("Far Sectors EP");

    expect(row).not.toHaveProperty("coordinate");

    expect(result.artist.socials).toEqual([
      { platform: "spotify", url: "https://open.spotify.com/artist/q" },
    ]);
    expect(result.artist.bio).toBe("A quiet one from the far sectors.");
    expect(result.artist).not.toHaveProperty("findingCount");

    expect(result.artist.findings ?? []).toEqual([]);
  });

  it("get_artist hides an artist with no public tracks", async () => {
    getPublicArtistBySlug.mockResolvedValue(undefined);
    countArtistFindings.mockResolvedValue(0);
    getFindingsByArtist.mockResolvedValue([]);

    const result = (await artistExecutor()({ name: "Faint Trace" }, {} as never)) as {
      artist?: { name?: string };
      found?: boolean;
    };

    expect(result).toEqual({ found: false, ok: true });
  });

  it("drops an entity finding with no coordinate before it reaches the model (the wire boundary)", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    countArtistFindings.mockResolvedValue(1);
    getFindingsByArtist.mockResolvedValue([
      { artists: ["Netsky"], logId: "004.7.2I", title: "Rio" },

      { artists: ["Netsky"], title: "Uncertified Cut" },
    ]);

    const result = (await artistExecutor()({ name: "Netsky" }, {} as never)) as {
      artist: { findings: { title?: string }[] };
    };

    expect(result.artist.findings).toHaveLength(1);
    expect(result.artist.findings[0]?.title).toBe("Rio");
  });

  it("get_artist ships the bio when the record carries one, and omits it when empty", async () => {
    countArtistFindings.mockResolvedValue(1);
    getFindingsByArtist.mockResolvedValue([
      { artists: ["Netsky"], logId: "004.7.2I", title: "Rio" },
    ]);
    getPublicArtistSocials.mockResolvedValue([]);

    getPublicArtistBySlug.mockResolvedValue({
      bio: "Belgian producer who bends liquid drum and bass toward daylight.",
      id: "art-1",
      name: "Netsky",
      slug: "netsky",
    });
    const withBio = (await artistExecutor()({ name: "Netsky" }, {} as never)) as {
      artist: { bio?: string };
    };
    expect(withBio.artist.bio).toBe(
      "Belgian producer who bends liquid drum and bass toward daylight.",
    );

    getPublicArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    const withoutBio = await artistExecutor()({ name: "Netsky" }, {} as never);
    expect(hasKeyDeep(withoutBio, "bio")).toBe(false);
  });

  it("get_label resolves a NAME through the slug helper and returns the label's findings + aliases", async () => {
    getLabelBySlug.mockResolvedValue({
      id: "lbl-1",
      logoImageUrl: "https://found.example/logo.png",
      name: "Hospital Records",
      slug: "hospital-records",
    });
    getFindingsByLabel.mockResolvedValue([
      { artists: ["Nu:Tone"], logId: "004.7.2I", title: "Better Places" },
    ]);
    getConfirmedAliasNames.mockResolvedValue(["Hospital"]);

    const result = (await labelExecutor()({ name: "Hospital Records" }, {} as never)) as {
      label: {
        aliases?: string[];
        findingCount?: number;
        findings: { coordinate?: string }[];
        logoUrl?: string;
        slug?: string;
      };
    };

    expect(labelSlug).toHaveBeenCalledWith("Hospital Records");
    expect(getLabelBySlug).toHaveBeenCalledWith("hospital-records");
    expect(result.label.slug).toBe("hospital-records");
    expect(result.label.findingCount).toBe(1);
    expect(result.label.findings.map((finding) => finding.coordinate)).toEqual(["004.7.2I"]);
    expect(result.label.aliases).toEqual(["Hospital"]);
    expect(result.label.logoUrl).toBe("https://found.example/logo.png");
  });

  it("get_label ships the bio when the record carries one, and omits it when empty", async () => {
    getFindingsByLabel.mockResolvedValue([
      { artists: ["Nu:Tone"], logId: "004.7.2I", title: "Better Places" },
    ]);
    getConfirmedAliasNames.mockResolvedValue([]);

    getLabelBySlug.mockResolvedValue({
      bio: "London imprint that has carried liquid drum and bass for two decades.",
      id: "lbl-1",
      logoImageUrl: undefined,
      name: "Hospital Records",
      slug: "hospital-records",
    });
    const withBio = (await labelExecutor()({ name: "Hospital Records" }, {} as never)) as {
      label: { bio?: string };
    };
    expect(withBio.label.bio).toBe(
      "London imprint that has carried liquid drum and bass for two decades.",
    );

    getLabelBySlug.mockResolvedValue({
      id: "lbl-1",
      logoImageUrl: undefined,
      name: "Hospital Records",
      slug: "hospital-records",
    });
    const withoutBio = await labelExecutor()({ name: "Hospital Records" }, {} as never);
    expect(hasKeyDeep(withoutBio, "bio")).toBe(false);
  });

  it("get_label returns the UNLIT entity (name + catalogue, no findings) for a catalogue-only label", async () => {
    getLabelBySlug.mockResolvedValue({
      bio: "A young imprint out past the certified sectors.",
      id: "lbl-2",
      logoImageUrl: "https://found.example/empty-imprint.png",
      name: "Empty Imprint",
      slug: "empty-imprint",
    });
    getFindingsByLabel.mockResolvedValue([]);
    getConfirmedAliasNames.mockResolvedValue(["Empty"]);
    listLabelCatalogue.mockResolvedValue({
      groups: [
        {
          name: "Some Artist",
          recordCount: 1,
          records: [
            {
              name: "Debut EP",
              releaseDate: undefined,
              slug: "debut-ep",
              tracks: [
                {
                  artists: ["Some Artist"],
                  spotifyUrl: "https://open.spotify.com/track/z",
                  title: "Drift",
                  trackId: "a",
                },
              ],
            },
          ],
          slug: "some-artist",
          truncated: false,
        },
      ],
      page: 1,
      pageCount: 1,
      totalGroups: 1,
      totalTracks: 1,
    });

    const result = (await labelExecutor()({ name: "Empty Imprint" }, {} as never)) as {
      label: {
        aliases?: string[];
        bio?: string;
        catalogue?: { release?: string; title: string }[];
        findings?: unknown[];
        name?: string;
        slug?: string;
      };
    };

    expect(result.label).toBeDefined();
    expect(result.label.name).toBe("Empty Imprint");
    expect(result.label.slug).toBe("empty-imprint");

    expect(listLabelCatalogue).toHaveBeenCalledWith("lbl-2", "name", 1);
    expect(result.label.catalogue).toHaveLength(1);
    const row = result.label.catalogue?.[0];
    expect(row?.title).toBe("Drift");
    expect(row?.release).toBe("Debut EP");

    expect(row).not.toHaveProperty("coordinate");

    expect(result.label.aliases).toEqual(["Empty"]);
    expect(result.label.bio).toBe("A young imprint out past the certified sectors.");
    expect(result.label).not.toHaveProperty("findingCount");

    expect(result.label.findings ?? []).toEqual([]);
  });

  it("get_label hides a label with no public tracks", async () => {
    getLabelBySlug.mockResolvedValue({
      id: "lbl-3",
      logoImageUrl: undefined,
      name: "Faint Imprint",
      slug: "faint-imprint",
    });
    getFindingsByLabel.mockResolvedValue([]);
    hasPublicGraphTracks.mockResolvedValue(false);

    const result = (await labelExecutor()({ name: "Faint Imprint" }, {} as never)) as {
      found?: boolean;
      label?: { name?: string };
    };

    expect(result).toEqual({ found: false, ok: true });
  });

  it("never leaks a previewUrl onto a get_artist or get_label output (the token stays server-side)", async () => {
    getPublicArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    countArtistFindings.mockResolvedValue(1);
    getFindingsByArtist.mockResolvedValue([
      {
        artists: ["Netsky"],
        logId: "004.7.2I",
        previewUrl: "https://deezer.example/expiring-a.mp3",
        title: "Rio",
      },
    ]);
    getLabelBySlug.mockResolvedValue({
      id: "lbl-1",
      logoImageUrl: undefined,
      name: "Hospital Records",
      slug: "hospital-records",
    });
    getFindingsByLabel.mockResolvedValue([
      {
        artists: ["Nu:Tone"],
        logId: "005.1.3B",
        previewUrl: "https://deezer.example/expiring-b.mp3",
        title: "Better Places",
      },
    ]);

    const artistResult = await artistExecutor()({ name: "Netsky" }, {} as never);
    const labelResult = await labelExecutor()({ name: "Hospital Records" }, {} as never);

    expect(hasKeyDeep(artistResult, "previewUrl")).toBe(false);
    expect(hasKeyDeep(labelResult, "previewUrl")).toBe(false);

    expect(hasKeyDeep(artistResult, "hasPreview")).toBe(true);
    expect(hasKeyDeep(labelResult, "hasPreview")).toBe(true);
  });
});

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasKeyDeep(entry, key));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([entryKey, entryValue]) => entryKey === key || hasKeyDeep(entryValue, key),
    );
  }

  return false;
}

describe("build_set — the chain card's grounding + the no-numbers invariant", () => {
  function buildSetExecutor() {
    const execute = buildChatTools().build_set?.execute;

    if (typeof execute !== "function") {
      throw new Error("build_set executor missing");
    }

    return execute;
  }

  function seedTargetIs(track: Record<string, unknown>) {
    return { kind: "track", track };
  }

  it("chains a set from a resolved coordinate seed — seed, ordered steps, and a /mix setUrl", async () => {
    const { resolveLogPageTarget } = await import("./log-resolver");
    vi.mocked(resolveLogPageTarget).mockResolvedValue(
      seedTargetIs({
        artists: ["Seed Artist"],
        durationMs: 200_000,
        logId: "004.7.2I",
        title: "Seed Track",
        trackId: "seed-t",
      }) as never,
    );
    getMixableTracks.mockResolvedValue([
      {
        artists: ["A One"],
        certified: true,
        durationMs: 210_000,
        logId: "005.1.3B",
        reason: { kind: "key", relationship: "same_key" },
        title: "One",
        trackId: "t1",
      },
      {
        artists: ["A Two"],
        certified: true,
        durationMs: 220_000,
        logId: "006.2.4C",
        reason: { kind: "bpm", relationship: "tempo_match" },
        title: "Two",
        trackId: "t2",
      },
    ]);

    getTracksByLogIds.mockResolvedValue({
      "005.1.3B": {
        albumImageUrl: "https://cover.example/one.jpg",
        artists: ["A One"],
        durationMs: 210_000,
        logId: "005.1.3B",
        previewUrl: "https://deezer.example/one.mp3",
        title: "One",
      },
      "006.2.4C": {
        artists: ["A Two"],
        durationMs: 220_000,
        logId: "006.2.4C",
        previewUrl: "https://deezer.example/two.mp3",
        title: "Two",
      },
    });

    const result = (await buildSetExecutor()({ seed: "004.7.2I" }, {} as never)) as {
      set: {
        seed: { coordinate?: string };
        setUrl: string;
        steps: { coordinate?: string; reason?: unknown }[];
      };
    };

    expect(getMixableTracks).toHaveBeenCalledWith("004.7.2I", { limit: 7 });
    expect(result.set.seed.coordinate).toBe("004.7.2I");
    expect(result.set.steps.map((step) => step.coordinate)).toEqual(["005.1.3B", "006.2.4C"]);

    expect(result.set.steps.map((step) => step.reason)).toEqual(["Same key", "Tempo locked"]);
    for (const step of result.set.steps) {
      expect(typeof step.reason).toBe("string");
    }

    expect(result.set.setUrl).toBe("/mix?set=004.7.2I,005.1.3B,006.2.4C");

    expect(hasKeyDeep(result, "score")).toBe(false);
    expect(hasKeyDeep(result, "previewUrl")).toBe(false);
  });

  it("chains a catalogue candidate in the UNLIT mix register (bpm/key/reason, trackId token, no coordinate)", async () => {
    const { resolveLogPageTarget } = await import("./log-resolver");
    vi.mocked(resolveLogPageTarget).mockResolvedValue(
      seedTargetIs({
        artists: ["Seed Artist"],
        durationMs: 200_000,
        logId: "004.7.2I",
        title: "Seed Track",
        trackId: "seed-t",
      }) as never,
    );
    getMixableTracks.mockResolvedValue([
      {
        artists: ["A One"],
        certified: true,
        durationMs: 210_000,
        logId: "005.1.3B",
        reason: { kind: "key", relationship: "same_key" },
        title: "One",
        trackId: "t1",
      },
      {
        artists: ["Catalogue Artist"],
        bpm: 174,
        certified: false,
        durationMs: 230_000,
        key: "F minor",

        logId: "999.9.9Z",
        reason: { kind: "sonic", relationship: "close_in_sound" },
        spotifyUrl: "https://open.spotify.com/track/cat",
        title: "Catalogue Cut",
        trackId: "t3",
      },
    ]);
    getTracksByLogIds.mockResolvedValue({
      "005.1.3B": { artists: ["A One"], durationMs: 210_000, logId: "005.1.3B", title: "One" },
    });

    const result = (await buildSetExecutor()({ seed: "004.7.2I" }, {} as never)) as {
      set: {
        setUrl: string;
        steps: {
          bpm?: number;
          coordinate?: string;
          key?: string;
          reason?: string;
          spotifyUrl?: string;
        }[];
      };
    };

    expect(result.set.steps).toHaveLength(2);
    expect(result.set.steps[0]?.coordinate).toBe("005.1.3B");

    const catalogueStep = result.set.steps[1];
    expect(catalogueStep?.coordinate).toBeUndefined();
    expect(catalogueStep?.reason).toBe("Close in sound");
    expect(catalogueStep?.bpm).toBe(174);
    expect(catalogueStep?.key).toBe("F minor");
    expect(catalogueStep?.spotifyUrl).toBe("https://open.spotify.com/track/cat");

    expect(result.set.setUrl).toBe("/mix?set=004.7.2I,005.1.3B,t3");
    expect(result.set.setUrl).not.toContain("999.9.9Z");

    const hydrated = getTracksByLogIds.mock.calls.at(-1)?.[0] ?? [];
    expect(hydrated).not.toContain("999.9.9Z");
    expect(hasKeyDeep(result, "score")).toBe(false);
  });

  it("resolves a NAME seed to the top certified search hit", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
      degraded: false,
      entities: [],
      kind: "token",
      results: [
        { artists: ["Uncertified"], certified: false, title: "Skip Me", trackId: "u" },
        {
          artists: ["Seed Artist"],
          certified: true,
          logId: "004.7.2I",
          title: "Seed Track",
          trackId: "seed-t",
        },
      ],
    } as never);
    getTracksByLogIds.mockResolvedValue({
      "004.7.2I": {
        artists: ["Seed Artist"],
        durationMs: 200_000,
        logId: "004.7.2I",
        title: "Seed Track",
      },
    });

    const result = (await buildSetExecutor()({ seed: "seed track" }, {} as never)) as {
      set: { seed: { coordinate?: string } };
    };

    expect(getMixableTracks).toHaveBeenCalledWith("004.7.2I", { limit: 7 });
    expect(result.set.seed.coordinate).toBe("004.7.2I");
  });

  it("returns found:false when the seed resolves to nothing certified", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
      degraded: false,
      entities: [],
      kind: "token",
      results: [{ artists: ["Uncertified"], certified: false, title: "Skip Me", trackId: "u" }],
    } as never);

    const result = await buildSetExecutor()({ seed: "nobody at all" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
    expect(getMixableTracks).not.toHaveBeenCalled();
  });

  it("says the archive is thin (steps: [], thin: true) when there is nothing to chain and the gate is closed", async () => {
    const { resolveLogPageTarget } = await import("./log-resolver");
    vi.mocked(resolveLogPageTarget).mockResolvedValue(
      seedTargetIs({
        artists: ["Seed Artist"],
        durationMs: 200_000,
        logId: "004.7.2I",
        title: "Seed Track",
        trackId: "seed-t",
      }) as never,
    );
    getMixableTracks.mockResolvedValue([]);
    getMixChainDepth.mockResolvedValue({ median: 3, open: false, rankable: 20 });

    const result = (await buildSetExecutor()({ seed: "004.7.2I" }, {} as never)) as {
      set: { seed: { coordinate?: string }; steps?: unknown[]; thin?: boolean };
    };

    expect(result.set.seed.coordinate).toBe("004.7.2I");
    expect(result.set.thin).toBe(true);

    expect(result.set.steps ?? []).toEqual([]);
    expect(hasKeyDeep(result, "setUrl")).toBe(false);
  });
});

describe("get_status — the status strip's shape", () => {
  function statusExecutor() {
    const execute = buildChatTools().get_status?.execute;

    if (typeof execute !== "function") {
      throw new Error("get_status executor missing");
    }

    return execute;
  }

  it("summarizes an all-up cosmos as { ok: true, headline }", async () => {
    const { getServiceStatuses } = await import("./status");
    vi.mocked(getServiceStatuses).mockResolvedValue([
      { service: "web", status: "up" },
      { service: "api", status: "up" },
    ] as never);

    const result = (await statusExecutor()({}, {} as never)) as {
      headline: string;
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.headline).toBe("All 2 systems are up.");

    expect(Object.keys(result).sort()).toEqual(["headline", "ok"]);
  });

  it("flags a down system as { ok: false, headline }", async () => {
    const { getServiceStatuses } = await import("./status");
    vi.mocked(getServiceStatuses).mockResolvedValue([
      { service: "web", status: "up" },
      { service: "api", status: "down" },
    ] as never);

    const result = (await statusExecutor()({}, {} as never)) as {
      headline: string;
      ok: boolean;
    };

    expect(result.ok).toBe(false);
    expect(result.headline).toContain("api down");
  });
});

describe("red-team — a browse over an uncrawled label carries no narration on catalogue rows", () => {
  const NARRATION_FIELDS = [
    "coordinate",
    "logId",
    "note",
    "observation",
    "bpm",
    "key",
    "galaxy",
    "albumImageUrl",
    "hasPreview",
    "found",
  ];

  it("search over an all-uncertified label returns only catalogue rows, none carrying a narration field", async () => {
    const { searchArchive } = await import("./search");
    vi.mocked(searchArchive).mockResolvedValue({
      degraded: false,
      entities: [],
      kind: "token",
      results: [
        {
          album: "Uncrawled LP",
          artists: ["Ghost Producer"],
          bpm: 172,
          certified: false,
          key: "A minor",
          label: "Uncrawled Label",
          spotifyUrl: "https://open.spotify.com/track/x1",
          title: "Out There One",
          trackId: "u1",
        },
        {
          artists: ["Another One"],
          certified: false,
          label: "Uncrawled Label",
          title: "Out There Two",
          trackId: "u2",
        },
      ],
    } as never);

    const execute = buildChatTools().search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    const result = (await execute(
      { query: "list everything out on Uncrawled Label" },
      {} as never,
    )) as { catalogue?: Record<string, unknown>[]; findings?: unknown[] };

    expect(result.findings ?? []).toHaveLength(0);
    expect(result.catalogue).toHaveLength(2);
    for (const row of result.catalogue ?? []) {
      for (const field of NARRATION_FIELDS) {
        expect(row, `catalogue row must not carry ${field}`).not.toHaveProperty(field);
      }
    }
  });
});

describe("streamChat — the unprovisioned guard", () => {
  it("returns null when OPENROUTER_API_KEY is unset (the route answers 503)", async () => {
    const messages = [
      { id: "msg-1", parts: [{ text: "you up?", type: "text" }], role: "user" },
    ] as unknown as FluncleUIMessage[];

    expect(await streamChat(messages)).toBeNull();
  });
});

describe("resolveChatModel", () => {
  it("defaults to the family the search tier trusts", async () => {
    expect(await resolveChatModel()).toBe("anthropic/claude-haiku-4.5");
  });

  it("honours OPENROUTER_CHAT_MODEL when set", async () => {
    readOptionalEnv.mockImplementation(async (name) =>
      name === "OPENROUTER_CHAT_MODEL" ? "anthropic/claude-sonnet-4.5" : undefined,
    );

    expect(await resolveChatModel()).toBe("anthropic/claude-sonnet-4.5");
  });
});
