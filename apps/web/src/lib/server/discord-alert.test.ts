import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyDiscordSignup } from "./discord-alert";

afterEach(() => {
  delete process.env.DISCORD_ALERT_WEBHOOK;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("notifyDiscordSignup", () => {
  it("is a no-op when the alert webhook is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyDiscordSignup({ crewNumber: 174 })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a privacy-safe signup alert and waits for Discord confirmation", async () => {
    process.env.DISCORD_ALERT_WEBHOOK = "https://discord.com/api/webhooks/test/token?thread_id=1";
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await notifyDiscordSignup({ crewNumber: 174 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("Discord webhook fetch was not called");
    }

    const [url, init] = call;
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) {
      throw new Error("Discord webhook fetch did not receive a URL");
    }

    expect(url.href).toBe("https://discord.com/api/webhooks/test/token?thread_id=1&wait=true");
    expect(init).toMatchObject({
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = init?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") {
      throw new Error("Discord webhook fetch did not receive a JSON body");
    }

    expect(JSON.parse(body)).toEqual({
      allowed_mentions: { parse: [] },
      content: "New crew member signed up — crew #174.",
    });
  });

  it("reports a rejected Discord delivery without exposing the webhook URL", async () => {
    process.env.DISCORD_ALERT_WEBHOOK = "https://discord.com/api/webhooks/test/secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    await expect(notifyDiscordSignup({})).rejects.toThrow(
      "Discord signup alert failed: 429 rate limited",
    );
  });
});

it.each(["request", "body"])("aborts a stalled Discord %s after 15 seconds", async (stage) => {
  process.env.DISCORD_ALERT_WEBHOOK = "https://discord.com/api/webhooks/test/token";
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      if (stage === "request") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
          { status: 429 },
        ),
      );
    }),
  );
  const result = notifyDiscordSignup({}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toMatchObject({ message: "Discord signup alert failed: request timed out" });
  expect(signal?.aborted).toBe(true);
});
