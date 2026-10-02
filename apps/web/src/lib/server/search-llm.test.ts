import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureCostEvents } from "./costs";
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
  vi.mocked(captureCostEvents).mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    if (typeof init?.body !== "string") {
      throw new Error("no request body was captured");
    }

    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("sends no reasoning field when OPENROUTER_REASONING_EFFORT is unset", async () => {
    fetchMock.mockResolvedValue(reply('{"artist":"Netsky"}'));

    await translateQuery("Netsky tracks");

    expect(sentBody().reasoning).toBeUndefined();
  });

  it("pins the reasoning effort on the request when the env names one", async () => {
    readOptionalEnv.mockImplementation(async (name) => {
      if (name === "OPENROUTER_API_KEY") {
        return "test-key";
      }
      if (name === "OPENROUTER_REASONING_EFFORT") {
        return "low";
      }
      return undefined;
    });
    fetchMock.mockResolvedValue(reply('{"artist":"Netsky"}'));

    await translateQuery("Netsky tracks");

    expect(sentBody().reasoning).toEqual({ effort: "low" });
  });

  it("puts the call on a deadline — a slow model must not become a slow search", async () => {
    fetchMock.mockResolvedValue(reply("{}"));

    await translateQuery("anything");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("filter translation deadlines and diagnostics", () => {
  it.each(["headers", "body"])(
    "returns null when %s exceed the deadline without recording cost",
    async (phase) => {
      vi.useFakeTimers();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const payload = await reply('{"artist":"Netsky"}').json();
      const delay = <T>(value: T) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(value), 3001));
      const response = {
        json: () => (phase === "body" ? delay(payload) : Promise.resolve(payload)),
        ok: true,
      };
      fetchMock.mockImplementation(() =>
        phase === "headers" ? delay(response) : Promise.resolve(response),
      );

      const result = translateQuery("Netsky");
      await vi.advanceTimersByTimeAsync(3001);

      await expect(result).resolves.toBeNull();
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal?.aborted).toBe(true);
      expect(captureCostEvents).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"failure":"SearchLlmTimeout"'));
    },
  );

  it.each([
    { failure: "SearchLlmHttpFailed", response: new Response(null, { status: 503 }) },
    { failure: "SearchLlmParseFailed", response: new Response("invalid JSON") },
    { failure: "SearchLlmParseFailed", response: reply("garbage") },
    { failure: "SearchLlmUnreachable", response: new TypeError("offline") },
  ])("returns null and diagnoses $failure", async ({ failure, response }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );

    await expect(translateQuery("anything")).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`"failure":"${failure}"`));
  });

  it("records consumed tokens even when the filter reply is invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(reply("garbage"));

    await expect(translateQuery("anything")).resolves.toBeNull();
    expect(captureCostEvents).toHaveBeenCalledTimes(1);
  });

  it("allows cost recording to finish after the outbound deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(reply('{"artist":"Netsky"}'));
    vi.mocked(captureCostEvents).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 3500)),
    );

    const result = translateQuery("Netsky");
    await vi.advanceTimersByTimeAsync(3500);

    await expect(result).resolves.toEqual({ artist: "Netsky" });
  });

  it("returns null and diagnoses a cost recording failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(reply('{"artist":"Netsky"}'));
    vi.mocked(captureCostEvents).mockRejectedValue(new Error("database unavailable"));

    await expect(translateQuery("Netsky")).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"failure":"SearchLlmCostFailed"'),
    );
  });
});
