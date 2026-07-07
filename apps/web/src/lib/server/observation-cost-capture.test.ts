import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// COST-01 Path A (Worker-local) capture, exercised through the REAL observation.ts
// vendor functions + the REAL costs.ts best-effort wrapper. Two guarantees:
//   1. a captured vendor call INSERTS a cost row (firecrawl `cash` request, the
//      OpenRouter distil `cash` tokens);
//   2. a LEDGER FAILURE (getDb throws) is swallowed — the vendor op still returns
//      its real result, proving the capture can NEVER break the note/observation.

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

// An OpenRouter completion that CARRIES `usage` (the field the capture reads).
const OPENROUTER_BODY = {
  choices: [{ message: { content: "Mr Right On is a 2017 Calibre track." } }],
  model: "anthropic/claude-haiku-4.5",
  usage: { completion_tokens: 40, prompt_tokens: 120 },
};

function mockVendorFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = typeof input === "string" ? input : String(input);

      if (url.includes(FIRECRAWL_MATCH)) {
        return Response.json(FIRECRAWL_BODY);
      }

      if (url.includes(OPENROUTER_MATCH)) {
        return Response.json(OPENROUTER_BODY);
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
    // Both vendors reached the ledger (vendor is the last col of each 13-tuple).
    expect(rows).toContain("firecrawl");
    expect(rows).toContain("openrouter");
    // The finding attribution rode along.
    expect(rows).toContain("004.7.2I");
    expect(rows).toContain("track-1");
  });

  it("distilContextNote prices the OpenRouter tokens (usd on the row, not null)", async () => {
    await distilContextNote(
      { query: "q", snippets: ["a snippet"], sources: [] },
      { logId: "004.7.2I", trackId: "track-1" },
    );

    // 120 in ($0.12/M×120) + 40 out ($5/M×40) → priced, so estimated_usd (col index
    // 3 of the 13-tuple) is a number, never null.
    const args = insertArgs().find((row) => row.includes("openrouter"));
    expect(args).toBeDefined();
    expect(typeof args?.[3]).toBe("number");
  });
});

describe("Path A best-effort — a ledger failure cannot break the vendor op", () => {
  it("fetchTrackContext still resolves when the ledger write throws", async () => {
    getDb.mockRejectedValue(new Error("turso down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The firecrawl search + distil succeeded; the swallowed ledger failure must
    // NOT downgrade the result to "failed".
    const result = await fetchTrackContext("Calibre Mr Right On", { trackId: "track-1" });

    expect(result.status).toBe("resolved");
    expect(result.contextNote).toContain("2017");

    spy.mockRestore();
  });
});
