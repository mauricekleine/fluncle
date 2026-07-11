import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFilterReply, translateQuery } from "./search-llm";

const readOptionalEnv = vi.hoisted(() => vi.fn<(name: string) => Promise<string | undefined>>());

vi.mock("./env", () => ({ readOptionalEnv }));
vi.mock("./costs", () => ({ captureCostEvents: vi.fn(), costEventId: () => "id" }));
vi.mock("./cost-rates", () => ({ priceOpenRouterTokens: () => 0.0001 }));

const fetchMock = vi.fn();

beforeEach(() => {
  readOptionalEnv.mockReset();
  readOptionalEnv.mockImplementation(async (name) =>
    name === "OPENROUTER_API_KEY" ? "test-key" : undefined,
  );
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A well-formed OpenRouter chat reply carrying `content`. */
function reply(content: string) {
  return {
    json: async () => ({
      choices: [{ message: { content } }],
      model: "anthropic/claude-haiku-4.5",
      usage: { completion_tokens: 20, cost: 0.00002, prompt_tokens: 300 },
    }),
    ok: true,
  };
}

describe("parseFilterReply — a model reply is untrusted input", () => {
  it("reads a clean filter object", () => {
    expect(parseFilterReply('{"artist":"Andromedik","key":"A minor"}')).toEqual({
      artist: "Andromedik",
      key: "A minor",
    });
  });

  it("survives a markdown fence and a sentence of preamble", () => {
    expect(parseFilterReply('Sure!\n```json\n{"label":"Hospital Records"}\n```')).toEqual({
      label: "Hospital Records",
    });
  });

  it("rejects a reply that is not JSON at all", () => {
    expect(parseFilterReply("I could not parse that query.")).toBeNull();
  });

  it("rejects a reply whose fields are the wrong types", () => {
    expect(parseFilterReply('{"bpmMin":"fast"}')).toBeNull();
  });

  it("treats an EMPTY filter object as no answer — never as 'return everything'", () => {
    expect(parseFilterReply("{}")).toBeNull();
  });

  // The safety property, restated as a test: the schema has no field that could name a
  // result, so a model that tries to hand back tracks hands back nothing.
  it("drops a hallucinated track list on the floor", () => {
    expect(
      parseFilterReply('{"tracks":[{"title":"A Song That Does Not Exist","logId":"999.9.9Z"}]}'),
    ).toBeNull();
  });
});

describe("translateQuery — and every way it is allowed to fail", () => {
  it("emits filters when the model answers", async () => {
    fetchMock.mockResolvedValue(reply('{"artist":"Netsky","key":"A minor"}'));

    expect(await translateQuery("Netsky tracks in A minor")).toEqual({
      artist: "Netsky",
      key: "A minor",
    });
  });

  it("returns null — never throws — when the vendor is unprovisioned (the local-dev steady state)", async () => {
    readOptionalEnv.mockResolvedValue(undefined);

    expect(await translateQuery("Netsky tracks in A minor")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the vendor errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    expect(await translateQuery("anything")).toBeNull();
  });

  it("returns null when the request times out or the network dies", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));

    expect(await translateQuery("anything")).toBeNull();
  });

  it("returns null when the reply is garbage", async () => {
    fetchMock.mockResolvedValue(reply("¯\\_(ツ)_/¯"));

    expect(await translateQuery("anything")).toBeNull();
  });

  it("puts the call on a deadline — a slow model must not become a slow search", async () => {
    fetchMock.mockResolvedValue(reply("{}"));

    await translateQuery("anything");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
