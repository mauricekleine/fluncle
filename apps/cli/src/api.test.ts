import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { publicApiGet, publicApiPost } from "./api";
import { armDeadline, resetDeadlineForTests } from "./deadline";
import { CliError, toJsonFailure } from "./output";

const originalBaseUrl = process.env.FLUNCLE_API_BASE_URL;
const fetchSpy = spyOn(globalThis, "fetch");

afterAll(() => {
  fetchSpy.mockRestore();
});

afterEach(() => {
  fetchSpy.mockReset();
  resetDeadlineForTests();

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

  test("preserves due-work branch attribution through the API failure and JSON output", async () => {
    const dueWork = { branch: "scheduled_promotion", workKind: "finding.context" };
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "due_work_maintenance_pending",
          dueWork,
          message: "Due-work maintenance is still converging",
          ok: false,
        }),
        { status: 503 },
      ),
    );
    const failure = await publicApiPost("/submit").catch((error: unknown) => error);
    expect(toJsonFailure(failure)).toMatchObject({
      code: "due_work_maintenance_pending",
      dueWork,
      ok: false,
    });
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

  test("a deadline that fires while a request is held open names that request and aborts it", async () => {
    process.env.FLUNCLE_API_BASE_URL = "https://fluncle.test";
    const reached = Promise.withResolvers<void>();
    const heldOpen = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        reached.resolve();
      });
    fetchSpy.mockImplementation(Object.assign(heldOpen, { preconnect: fetch.preconnect }));
    const scheduled: (() => void)[] = [];
    const reports: string[] = [];
    const beforeExitCode = process.exitCode;

    try {
      armDeadline(3, {
        command: "tracks get trk_1234",
        exit: () => {},
        json: true,
        report: (message) => reports.push(message),
        schedule: (fire) => {
          scheduled.push(fire);
          return () => {};
        },
      });
      const request = publicApiGet("/api/v1/tracks/trk_1234").catch((error: unknown) => error);
      await reached.promise;
      scheduled[0]?.();

      expect(reports).toEqual([
        "fluncle tracks get trk_1234 stopped after 3 s: waiting for the Fluncle API: GET /api/v1/tracks/trk_1234. Set --timeout or FLUNCLE_TIMEOUT in seconds (0 disables the deadline).",
      ]);
      expect(toJsonFailure(await request)).toMatchObject({ code: "timeout", ok: false });
    } finally {
      process.exitCode = beforeExitCode ?? 0;
    }
  });
});
