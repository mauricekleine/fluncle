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
const toArtistSlug = vi.hoisted(() => vi.fn<(name: string) => string>());
const getArtistBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
const getPublicArtistSocials = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const countArtistFindings = vi.hoisted(() => vi.fn<() => Promise<number>>());
const labelSlug = vi.hoisted(() => vi.fn<(name: string) => string | undefined>());
const getLabelBySlug = vi.hoisted(() => vi.fn<(slug: string) => Promise<unknown>>());
const getConfirmedAliasNames = vi.hoisted(() => vi.fn<() => Promise<string[]>>());

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
      "get_artist",
      "get_label",
      "get_random_track",
      "get_status",
      "get_track",
      "list_tracks",
      "search_archive",
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
