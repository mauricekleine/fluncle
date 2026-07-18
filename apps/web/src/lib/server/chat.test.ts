import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The archive/DB modules the tools wire to are mocked: this suite exercises the PURE parts
// (the grounding prompt, request parsing, tool SHAPE, the unprovisioned guard, the model
// resolve). The tools' `execute` closures — the only DB-touching part — are covered by the
// route at runtime, not here.
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
const getArtistBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
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

// A faithful stand-in for the real deterministic slug helpers (the DB-touching modules stay
// mocked). "Netsky" → "netsky", "Hospital Records" → "hospital-records" — enough to prove the
// name → helper → getBySlug wiring without importing node:crypto + spotify + db.
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
  getArtistBySlug,
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
  listTracks: vi.fn(),
  toPublicTrackListItem: (item: unknown) => item,
}));

import {
  buildChatTools,
  FLUNCLE_CHAT_SYSTEM_PROMPT,
  type FluncleUIMessage,
  parseChatRequest,
  resolveChatModel,
  streamChat,
} from "./chat";

beforeEach(() => {
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue(undefined);
  getTracksByLogIds.mockReset();
  // Default: the hydrator finds nothing, so search falls back to the bare hit shape. Tests that
  // exercise the rich card path override this with the findings they expect hydrated.
  getTracksByLogIds.mockResolvedValue({});

  // Entity tools default to "resolves to nothing" so an unrelated test never trips them; the
  // entity suite overrides these with the records it expects.
  getFindingsByArtist.mockReset();
  getFindingsByArtist.mockResolvedValue([]);
  getFindingsByLabel.mockReset();
  getFindingsByLabel.mockResolvedValue([]);
  // build_set defaults: no chain, and a deep-enough archive (so an empty chain is "just this
  // seed", not "thin"). The build_set suite overrides both with the fixtures it needs.
  getMixableTracks.mockReset();
  getMixableTracks.mockResolvedValue([]);
  getMixChainDepth.mockReset();
  getMixChainDepth.mockResolvedValue({ median: 40, open: true, rankable: 100 });
  toArtistSlug.mockReset();
  toArtistSlug.mockImplementation(toSlug);
  getArtistBySlug.mockReset();
  getArtistBySlug.mockResolvedValue(undefined);
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
  // list_fresh defaults to "nothing came out" so an unrelated test never trips it; the fresh
  // suite overrides it with the release rows it needs.
  listFreshTracks.mockReset();
  listFreshTracks.mockResolvedValue({ albums: [], tracks: [], windowDays: 30 });
  // get_similar_artists defaults to "no neighbours yet"; its suite overrides with real neighbours.
  getArtistNeighbours.mockReset();
  getArtistNeighbours.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FLUNCLE_CHAT_SYSTEM_PROMPT — the grounding rule is the product", () => {
  it("mandates answering only from the tools and refusing to invent", () => {
    const prompt = FLUNCLE_CHAT_SYSTEM_PROMPT.toLowerCase();

    // The grounding rail: every fact comes from a tool result, and the empty case is honesty.
    expect(prompt).toContain("from the archive or you do not answer");
    expect(prompt).toContain("must come from a tool result");
    expect(prompt).toContain("never invent");
    // The catalogue rule: only certified findings.
    expect(prompt).toContain("certified");
    // The voice rail (the most exposed his voice gets).
    expect(FLUNCLE_CHAT_SYSTEM_PROMPT).toContain("No exclamation marks");
    // ...and the prompt itself never breaks it.
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
});

describe("buildChatTools — the MCP hands", () => {
  it("exposes exactly the archive verbs, each with an input schema and an executor", () => {
    const tools = buildChatTools();

    expect(Object.keys(tools).sort()).toEqual([
      "build_set",
      "get_artist",
      "get_label",
      "get_random_track",
      "get_similar_artists",
      "get_status",
      "get_track",
      "list_fresh",
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

  it("only certified findings reach the model from search (the catalogue rule at the wire)", async () => {
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
        { artists: ["Someone"], certified: false, title: "An Uncertified Cut", trackId: "b" },
      ],
    } as never);

    const tools = buildChatTools();
    const execute = tools.search_archive?.execute;
    if (typeof execute !== "function") {
      throw new Error("search_archive executor missing");
    }

    const result = (await execute({ query: "nu:tone" }, {} as never)) as {
      findings: { coordinate?: string; title: string }[];
    };

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Better Places");
    expect(result.findings[0]?.coordinate).toBe("004.7.2I");
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

    // The batch hydrator resolves the certified hit to its full DTO — the source of the cover,
    // the duration, and the (private, expiring) previewUrl the card must NOT receive.
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
          // An uncertified row can carry a coordinate-shaped id; it must still never be hydrated.
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

  it("list_fresh returns only certified findings — an uncertified release never reaches the model", async () => {
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
          // An uncertified catalogue release can carry a coordinate-shaped id; it must still
          // never be named or hydrated (the Unlit Rule at the wire).
          logId: "999.9.9Z",
          releaseDate: "2026-07-16",
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
      findings: { coordinate?: string; title: string }[];
    };

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Better Places");
    expect(result.findings[0]?.coordinate).toBe("004.7.2I");
    // The uncertified release's logId is never even hydrated (the filter is BEFORE the hydrator).
    const lookedUp = getTracksByLogIds.mock.calls.at(-1)?.[0] ?? [];
    expect(lookedUp).toContain("004.7.2I");
    expect(lookedUp).not.toContain("999.9.9Z");
  });

  it("exposes the two WRITE verbs on chat, each with an input schema + executor", () => {
    // PR-2 puts submit_track + subscribe_newsletter on ChatDnB (gated-session-safe), so Fluncle
    // can take a submission / newsletter signup mid-conversation.
    const tools = buildChatTools();

    for (const name of ["submit_track", "subscribe_newsletter"] as const) {
      expect(tools[name]?.inputSchema, `${name} needs a schema`).toBeDefined();
      expect(typeof tools[name]?.execute, `${name} needs an executor`).toBe("function");
    }
  });
});

describe("get_similar_artists — the artist-discovery read", () => {
  function similarExecutor() {
    const execute = buildChatTools().get_similar_artists?.execute;

    if (typeof execute !== "function") {
      throw new Error("get_similar_artists executor missing");
    }

    return execute;
  }

  it("resolves a NAME through the slug helper and passes the artist id to getArtistNeighbours", async () => {
    getArtistBySlug.mockResolvedValue({ id: "art-1", name: "Koven", slug: "koven" });
    getArtistNeighbours.mockResolvedValue([
      { imageUrl: "https://cover.example/a.jpg", name: "Camo & Krooked", slug: "camo-krooked" },
      { name: "Metrik", slug: "metrik" },
    ]);

    const result = (await similarExecutor()({ name: "Koven" }, {} as never)) as {
      of: { name?: string; slug?: string };
      similar: { name: string; slug: string }[];
    };

    // name → slug helper → getArtistBySlug(slug) — the same resolution get_artist uses.
    expect(toArtistSlug).toHaveBeenCalledWith("Koven");
    expect(getArtistBySlug).toHaveBeenCalledWith("koven");
    // A thin pass-through: the id goes to getArtistNeighbours, and its list rides back unchanged.
    expect(getArtistNeighbours).toHaveBeenCalledWith("art-1", expect.any(Number));
    expect(result.of).toEqual({ name: "Koven", slug: "koven" });
    expect(result.similar.map((artist) => artist.slug)).toEqual(["camo-krooked", "metrik"]);
  });

  it("returns found:false when the name resolves to no artist he has logged", async () => {
    getArtistBySlug.mockResolvedValue(undefined);

    const result = await similarExecutor()({ name: "Nobody At All" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
    expect(getArtistNeighbours).not.toHaveBeenCalled();
  });

  it("returns an honest empty list when the artist has no neighbours yet (not found:false)", async () => {
    getArtistBySlug.mockResolvedValue({ id: "art-2", name: "Quiet One", slug: "quiet-one" });
    getArtistNeighbours.mockResolvedValue([]);

    const result = (await similarExecutor()({ name: "Quiet One" }, {} as never)) as {
      ok: boolean;
      similar: unknown[];
    };

    expect(result.ok).toBe(true);
    expect(result.similar).toEqual([]);
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
    getArtistBySlug.mockResolvedValue({
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

    // name → slug helper → getArtistBySlug(slug) is the resolution the /artist page uses.
    expect(toArtistSlug).toHaveBeenCalledWith("Netsky");
    expect(getArtistBySlug).toHaveBeenCalledWith("netsky");
    expect(result.artist.slug).toBe("netsky");
    expect(result.artist.findingCount).toBe(2);
    expect(result.artist.findings.map((finding) => finding.coordinate)).toEqual([
      "004.7.2I",
      "005.1.3B",
    ]);
    // The avatar is the freshest certified finding's cover (no avatar rides on the record).
    expect(result.artist.avatarUrl).toBe("https://cover.example/rio.jpg");
    expect(result.artist.socials).toEqual([
      { platform: "spotify", url: "https://open.spotify.com/artist/x" },
    ]);
  });

  it("get_artist returns found:false when the name resolves to no artist he has logged", async () => {
    getArtistBySlug.mockResolvedValue(undefined);

    const result = await artistExecutor()({ name: "Nobody At All" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
  });

  it("get_artist returns found:false for an artist with zero certified findings", async () => {
    getArtistBySlug.mockResolvedValue({ id: "art-2", name: "Quiet One", slug: "quiet-one" });
    countArtistFindings.mockResolvedValue(0);
    getFindingsByArtist.mockResolvedValue([]);

    const result = await artistExecutor()({ name: "Quiet One" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
  });

  it("drops an entity finding with no coordinate before it reaches the model (the wire boundary)", async () => {
    getArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
    countArtistFindings.mockResolvedValue(1);
    getFindingsByArtist.mockResolvedValue([
      { artists: ["Netsky"], logId: "004.7.2I", title: "Rio" },
      // No logId → no coordinate → never something Fluncle speaks about, so it is dropped.
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

    getArtistBySlug.mockResolvedValue({
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

    // No bio on the record → `dropEmpty` strips the key entirely (not a null / empty string).
    getArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
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

    // No bio on the record → `dropEmpty` strips the key entirely (not a null / empty string).
    getLabelBySlug.mockResolvedValue({
      id: "lbl-1",
      logoImageUrl: undefined,
      name: "Hospital Records",
      slug: "hospital-records",
    });
    const withoutBio = await labelExecutor()({ name: "Hospital Records" }, {} as never);
    expect(hasKeyDeep(withoutBio, "bio")).toBe(false);
  });

  it("get_label returns found:false for a label with no certified finding on it", async () => {
    getLabelBySlug.mockResolvedValue({
      id: "lbl-2",
      logoImageUrl: undefined,
      name: "Empty Imprint",
      slug: "empty-imprint",
    });
    getFindingsByLabel.mockResolvedValue([]);

    const result = await labelExecutor()({ name: "Empty Imprint" }, {} as never);

    expect(result).toEqual({ found: false, ok: true });
  });

  it("never leaks a previewUrl onto a get_artist or get_label output (the token stays server-side)", async () => {
    getArtistBySlug.mockResolvedValue({ id: "art-1", name: "Netsky", slug: "netsky" });
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
    // The derived boolean DID ride through — the card still knows a preview exists.
    expect(hasKeyDeep(artistResult, "hasPreview")).toBe(true);
    expect(hasKeyDeep(labelResult, "hasPreview")).toBe(true);
  });
});

/** Walk any value and report whether `key` appears anywhere in it (arrays + nested objects). */
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

  // A real finding coordinate (isLogId is the unmocked grammar guard) resolving to a seed track.
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
    // The certified steps hydrate to full findings (the card fields), carrying the private,
    // expiring previewUrl the output must NOT leak.
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

    // The seed came from the coordinate resolver, and the engine was asked from the seed's logId.
    expect(getMixableTracks).toHaveBeenCalledWith("004.7.2I", { limit: 7 });
    expect(result.set.seed.coordinate).toBe("004.7.2I");
    expect(result.set.steps.map((step) => step.coordinate)).toEqual(["005.1.3B", "006.2.4C"]);
    // Every step's reason is a human STRING (mixReasonLabel), never the reason object.
    expect(result.set.steps.map((step) => step.reason)).toEqual(["Same key", "Tempo locked"]);
    for (const step of result.set.steps) {
      expect(typeof step.reason).toBe("string");
    }
    // The handoff carries the seed FIRST, then the chain in order — all certified Log IDs.
    expect(result.set.setUrl).toBe("/mix?set=004.7.2I,005.1.3B,006.2.4C");
    // No numeric score, and no expiring preview token, anywhere in the output.
    expect(hasKeyDeep(result, "score")).toBe(false);
    expect(hasKeyDeep(result, "previewUrl")).toBe(false);
  });

  it("drops an uncertified candidate from the steps AND from the setUrl (the grounding boundary)", async () => {
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
        artists: ["Uncertified"],
        certified: false,
        durationMs: 230_000,
        // An uncertified row can carry a coordinate-shaped id; it must still never be named or linked.
        logId: "999.9.9Z",
        reason: { kind: "sonic", relationship: "close_in_sound" },
        title: "Catalogue Cut",
        trackId: "t3",
      },
    ]);
    getTracksByLogIds.mockResolvedValue({
      "005.1.3B": { artists: ["A One"], durationMs: 210_000, logId: "005.1.3B", title: "One" },
    });

    const result = (await buildSetExecutor()({ seed: "004.7.2I" }, {} as never)) as {
      set: { setUrl: string; steps: { coordinate?: string }[] };
    };

    expect(result.set.steps.map((step) => step.coordinate)).toEqual(["005.1.3B"]);
    expect(result.set.setUrl).toBe("/mix?set=004.7.2I,005.1.3B");
    expect(result.set.setUrl).not.toContain("999.9.9Z");
    // The uncertified logId is never even hydrated (the filter is BEFORE the hydrator).
    const hydrated = getTracksByLogIds.mock.calls.at(-1)?.[0] ?? [];
    expect(hydrated).not.toContain("999.9.9Z");
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

    // The seed resolved via the certified hit's logId, and the engine was asked from it.
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
    // No chain and no handoff — a lonely seed is not a set.
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
    // The strip renders exactly these two fields — nothing else rides the output.
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
