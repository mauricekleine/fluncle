import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: (...args: unknown[]) => getDb(...args),
}));

const { distilContextNote, fetchTrackContext } = await import("./observation");

const FIRECRAWL_MATCH = "api.firecrawl.dev/v2/search";
const OPENROUTER_MATCH = "openrouter.ai/api/v1/chat/completions";

const FIRECRAWL_BODY = {
  data: {
    web: [
      {
        description: "Released 2017 on Signature Recordings.",
        title: "Calibre - Mr Right On",
        url: "https://discogs.com/release/123",
      },
    ],
  },
};

const OPENROUTER_BODY_MEASURED = {
  choices: [{ message: { content: "Mr Right On is a 2017 Calibre track." } }],
  model: "anthropic/claude-haiku-4.5",
  usage: { completion_tokens: 40, cost: 0.0031, prompt_tokens: 120 },
};

const OPENROUTER_BODY_NO_COST = {
  choices: [{ message: { content: "Mr Right On is a 2017 Calibre track." } }],
  model: "anthropic/claude-haiku-4.5",
  usage: { completion_tokens: 40, prompt_tokens: 120 },
};

let openRouterBody: unknown = OPENROUTER_BODY_MEASURED;

function setOpenRouterBody(body: unknown) {
  openRouterBody = body;
}

function mockVendorFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = typeof input === "string" ? input : String(input);

      if (url.includes(FIRECRAWL_MATCH)) {
        return Response.json(FIRECRAWL_BODY);
      }

      if (url.includes(OPENROUTER_MATCH)) {
        return Response.json(openRouterBody);
      }

      return new Response("not found", { status: 404 });
    }),
  );
}

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "test-firecrawl";
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  delete process.env.OPENROUTER_CONTEXT_MODEL;
  execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  getDb.mockReset().mockResolvedValue({ execute });
  setOpenRouterBody(OPENROUTER_BODY_MEASURED);
  mockVendorFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function insertArgs(): unknown[][] {
  return execute.mock.calls
    .filter((call) => String(call[0]?.sql ?? "").includes("insert into cost_events"))
    .map((call) => (call[0]?.args ?? []) as unknown[]);
}

describe("Path A capture — inserts a cost row per vendor call", () => {
  it("fetchTrackContext inserts a firecrawl cash request row + an openrouter distil row", async () => {
    const result = await fetchTrackContext("Calibre Mr Right On", {
      logId: "004.7.2I",
      trackId: "track-1",
    });

    expect(result.status).toBe("resolved");

    const rows = insertArgs().flat();

    expect(rows).toContain("firecrawl");
    expect(rows).toContain("openrouter");

    expect(rows).toContain("004.7.2I");
    expect(rows).toContain("track-1");
  });

  it("distilContextNote stores OpenRouter's OWN billed cost (usage.cost, measured)", async () => {
    await distilContextNote(
      { query: "q", snippets: ["a snippet"], sources: [] },
      { logId: "004.7.2I", trackId: "track-1" },
    );

    const args = insertArgs().find((row) => row.includes("openrouter"));
    expect(args).toBeDefined();
    expect(args?.[3]).toBe(0.0031);
    expect(args?.[8]).toBe("measured");
  });

  it("distilContextNote falls back to the token rate (estimated) when usage.cost is absent", async () => {
    setOpenRouterBody(OPENROUTER_BODY_NO_COST);

    await distilContextNote(
      { query: "q", snippets: ["a snippet"], sources: [] },
      { logId: "004.7.2I", trackId: "track-1" },
    );

    const args = insertArgs().find((row) => row.includes("openrouter"));
    expect(args).toBeDefined();
    expect(typeof args?.[3]).toBe("number");
    expect(args?.[8]).toBe("estimated");
  });
});

describe("Path A best-effort — a ledger failure cannot break the vendor op", () => {
  it("fetchTrackContext still resolves when the ledger write throws", async () => {
    getDb.mockRejectedValue(new Error("turso down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchTrackContext("Calibre Mr Right On", { trackId: "track-1" });

    expect(result.status).toBe("resolved");
    expect(result.contextNote).toContain("2017");

    spy.mockRestore();
  });
});
