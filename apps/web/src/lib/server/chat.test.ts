import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TextStreamPart, type ToolSet } from "ai";

// The archive/DB modules the tools wire to are mocked: this suite exercises the PURE parts
// (the grounding prompt, request parsing, tool SHAPE, the transcript event mapping, the model
// resolve). The tools' `execute` closures — the only DB-touching part — are covered by the
// route at runtime, not here.
const readOptionalEnv = vi.hoisted(() => vi.fn<(name: string) => Promise<string | undefined>>());

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./search", () => ({ searchArchive: vi.fn() }));
vi.mock("./log-resolver", () => ({ resolveLogPageTarget: vi.fn() }));
vi.mock("./status", () => ({ getServiceStatuses: vi.fn() }));
vi.mock("./tracks", () => ({
  getRandomTrack: vi.fn(),
  listTracks: vi.fn(),
  toPublicTrackListItem: (item: unknown) => item,
}));

import {
  buildChatTools,
  type ChatMessage,
  FLUNCLE_CHAT_SYSTEM_PROMPT,
  parseChatRequest,
  resolveChatModel,
  toTranscriptEvent,
} from "./chat";

beforeEach(() => {
  readOptionalEnv.mockReset();
  readOptionalEnv.mockResolvedValue(undefined);
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
  it("accepts a well-formed turn history", () => {
    const messages: ChatMessage[] = [
      { content: "what's on Hospital?", role: "user" },
      { content: "let me dig", role: "assistant" },
    ];

    expect(parseChatRequest({ messages })).toEqual(messages);
  });

  it("rejects malformed bodies", () => {
    expect(parseChatRequest({ messages: [] })).toBeNull();
    expect(parseChatRequest({ messages: [{ content: "hi", role: "system" }] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "user" }] })).toBeNull();
    expect(parseChatRequest({})).toBeNull();
    expect(parseChatRequest("nope")).toBeNull();
  });
});

describe("buildChatTools — the MCP hands", () => {
  it("exposes exactly the archive verbs, each with an input schema and an executor", () => {
    const tools = buildChatTools();

    expect(Object.keys(tools).sort()).toEqual([
      "get_random_track",
      "get_status",
      "get_track",
      "list_tracks",
      "search_archive",
    ]);

    for (const name of Object.keys(tools)) {
      const definition = tools[name];
      expect(definition?.inputSchema, `${name} needs an input schema`).toBeDefined();
      expect(typeof definition?.execute, `${name} needs an executor`).toBe("function");
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
});

describe("toTranscriptEvent — the NDJSON mapping", () => {
  const part = (value: object) => value as unknown as TextStreamPart<ToolSet>;

  it("maps the events the workbench renders", () => {
    expect(toTranscriptEvent(part({ id: "1", text: "oof", type: "text-delta" }))).toEqual({
      text: "oof",
      type: "text",
    });
    expect(
      toTranscriptEvent(part({ input: { q: "x" }, toolName: "search_archive", type: "tool-call" })),
    ).toEqual({ input: { q: "x" }, name: "search_archive", type: "tool-call" });
    expect(
      toTranscriptEvent(part({ output: { ok: true }, toolName: "get_track", type: "tool-result" })),
    ).toEqual({ name: "get_track", output: { ok: true }, type: "tool-result" });
    expect(
      toTranscriptEvent(
        part({ error: new Error("boom"), toolName: "get_status", type: "tool-error" }),
      ),
    ).toEqual({ error: "boom", name: "get_status", type: "tool-error" });
    expect(toTranscriptEvent(part({ error: "down", type: "error" }))).toEqual({
      error: "down",
      type: "error",
    });
    expect(toTranscriptEvent(part({ type: "finish" }))).toEqual({ type: "done" });
  });

  it("drops the low-level chatter the workbench does not show", () => {
    expect(toTranscriptEvent(part({ type: "start" }))).toBeNull();
    expect(toTranscriptEvent(part({ type: "start-step" }))).toBeNull();
    expect(toTranscriptEvent(part({ id: "1", text: "", type: "text-delta" }))).toBeNull();
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
