import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { publicApiPost } from "./api";
import { CliError, toJsonFailure } from "./output";

const originalBaseUrl = process.env.FLUNCLE_API_BASE_URL;
const fetchSpy = spyOn(globalThis, "fetch");

afterAll(() => {
  fetchSpy.mockRestore();
});

afterEach(() => {
  fetchSpy.mockReset();

  if (originalBaseUrl === undefined) {
    delete process.env.FLUNCLE_API_BASE_URL;
  } else {
    process.env.FLUNCLE_API_BASE_URL = originalBaseUrl;
  }
});

describe("API Promise boundary", () => {
  test("sends the JSON request and returns the parsed response", async () => {
    process.env.FLUNCLE_API_BASE_URL = "https://fluncle.test/";
    fetchSpy.mockResolvedValue(new Response('{"ok":true}'));

    expect(await publicApiPost<{ ok: boolean }>("/submit", { title: "Track" })).toEqual({
      ok: true,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://fluncle.test/submit",
      expect.objectContaining({
        body: '{"title":"Track"}',
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
  });

  test("returns undefined for an empty successful response", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    expect(await publicApiPost("/submit")).toBeUndefined();
  });

  test.each([
    {
      body: '{"ok":false,"code":"duplicate","message":"Already published: Artist — Track"}',
      code: "duplicate",
      message: "Already published: Artist — Track",
      status: 409,
      statusText: "Conflict",
    },
    {
      body: "{}",
      code: "http_503",
      message: "503 Service Unavailable",
      status: 503,
      statusText: "Service Unavailable",
    },
    {
      body: "<html>unavailable</html>\n",
      code: "invalid_api_response",
      message: "<html>unavailable</html>\n",
      status: 503,
      statusText: "Service Unavailable",
    },
    {
      body: "invalid JSON",
      code: "invalid_api_response",
      message: "invalid JSON",
      status: 200,
      statusText: "OK",
    },
  ])("preserves error bytes for $code ($status)", async (input) => {
    fetchSpy.mockResolvedValue(
      new Response(input.body, { status: input.status, statusText: input.statusText }),
    );

    const failure: unknown = await publicApiPost("/submit").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect(toJsonFailure(failure)).toEqual({
      code: input.code,
      message: input.message,
      ok: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each([new Error("ECONNRESET"), "connection lost"])(
    "rejects with the original transport failure %s",
    async (failure) => {
      fetchSpy.mockRejectedValue(failure);

      expect(await publicApiPost("/submit").catch((error: unknown) => error)).toBe(failure);
    },
  );

  test("rejects with the original body-read failure", async () => {
    const failure = new Error("body stream disconnected");
    const response = new Response("");
    spyOn(response, "text").mockRejectedValue(failure);
    fetchSpy.mockResolvedValue(response);

    expect(await publicApiPost("/submit").catch((error: unknown) => error)).toBe(failure);
  });
});
