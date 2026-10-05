import { describe, expect, it, vi } from "vitest";
import { BROWSER_SENTRY_DSN, SENTRY_TUNNEL_PATH, WORKER_SENTRY_DSN } from "../sentry-config";
import {
  handleSentryTunnel,
  isSentryTunnelRequest,
  SENTRY_TUNNEL_MAX_BYTES,
} from "./sentry-tunnel";

function envelope(dsn = BROWSER_SENTRY_DSN): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(`${JSON.stringify({ dsn })}\n{"type":"attachment"}\n`);
  const bytes = new Uint8Array(header.length + 3);
  bytes.set(header);
  bytes.set([0, 128, 255], header.length);
  return bytes;
}

function post(body: BodyInit, headers: HeadersInit = {}): Request {
  const init = { body, duplex: "half", headers, method: "POST" };

  return new Request(`https://www.fluncle.com${SENTRY_TUNNEL_PATH}`, init);
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code, message: expect.any(String), ok: false });
}

describe("Sentry envelope tunnel", () => {
  it.each([BROWSER_SENTRY_DSN, WORKER_SENTRY_DSN])(
    "relays %s envelopes unchanged without visitor headers",
    async (dsn) => {
      const body = envelope(dsn);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("accepted", { status: 202 }));
      const response = await handleSentryTunnel(
        post(body, {
          Authorization: "Bearer private",
          "CF-Connecting-IP": "visitor-ip",
          "Content-Encoding": "identity",
          "Content-Type": "text/plain",
          Cookie: "session=private",
          "X-Forwarded-For": "visitor-ip",
          "X-Real-IP": "visitor-ip",
        }),
        fetchImpl,
      );
      const parsed = new URL(dsn);

      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `https://${parsed.host}/api/${parsed.pathname.slice(1)}/envelope/`,
        {
          body,
          headers: { "Content-Type": "application/x-sentry-envelope" },
          method: "POST",
        },
      );
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("accepted");
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  const browserDsn = new URL(BROWSER_SENTRY_DSN);
  const foreignHost = new URL(BROWSER_SENTRY_DSN);
  foreignHost.host = "example.com";
  const foreignProject = new URL(BROWSER_SENTRY_DSN);
  foreignProject.pathname = "/0";
  const insecureDsn = new URL(BROWSER_SENTRY_DSN);
  insecureDsn.protocol = "http:";
  const foreignPort = new URL(BROWSER_SENTRY_DSN);
  foreignPort.port = "444";

  it.each([
    ["foreign host", envelope(foreignHost.href), "invalid_dsn"],
    ["foreign project", envelope(foreignProject.href), "invalid_dsn"],
    ["insecure protocol", envelope(insecureDsn.href), "invalid_dsn"],
    ["foreign port", envelope(foreignPort.href), "invalid_dsn"],
    ["missing newline", JSON.stringify({ dsn: browserDsn.href }), "invalid_envelope"],
    ["empty body", "", "invalid_envelope"],
    ["garbage JSON", "not JSON\n{}", "invalid_envelope"],
    ["missing DSN", "{}\n{}", "invalid_envelope"],
    ["non-string DSN", '{"dsn":42}\n{}', "invalid_envelope"],
    ["unparseable DSN", '{"dsn":"not a URL"}\n{}', "invalid_envelope"],
    ["null header", "null\n{}", "invalid_envelope"],
  ])("rejects %s before contacting upstream", async (_name, body, code) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleSentryTunnel(post(body), fetchImpl);

    await expectError(response, 400, code);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires POST", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleSentryTunnel(
      new Request(`https://www.fluncle.com${SENTRY_TUNNEL_PATH}`),
      fetchImpl,
    );

    await expectError(response, 405, "method_not_allowed");
    expect(response.headers.get("allow")).toBe("POST");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before reading it", async () => {
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleSentryTunnel(
      post(stream, { "Content-Length": String(SENTRY_TUNNEL_MAX_BYTES + 1) }),
      fetchImpl,
    );

    await expectError(response, 413, "payload_too_large");
    expect(pull).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops and cancels a chunked body as soon as it exceeds the cap", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(SENTRY_TUNNEL_MAX_BYTES / 2 + 1));
    });
    const stream = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleSentryTunnel(post(stream), fetchImpl);

    await expectError(response, 413, "payload_too_large");
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a body at the cap even when the header crosses chunks", async () => {
    const body = new Uint8Array(SENTRY_TUNNEL_MAX_BYTES);
    body.set(envelope());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 4));
        controller.enqueue(body.subarray(4));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const response = await handleSentryTunnel(post(stream), fetchImpl);

    expect(response.status).toBe(204);
    const sent = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent instanceof Uint8Array && Buffer.from(sent).equals(Buffer.from(body))).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses compressed envelopes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await handleSentryTunnel(
      post(envelope(), { "Content-Encoding": "gzip" }),
      fetchImpl,
    );

    await expectError(response, 415, "unsupported_encoding");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves upstream rate limits and body while dropping other headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("rate limited", {
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/plain",
          "Retry-After": "60",
          "Set-Cookie": "private=value",
          "X-Sentry-Rate-Limits": "60:error:project",
          "X-Upstream": "private",
        },
        status: 429,
      }),
    );
    const response = await handleSentryTunnel(post(envelope()), fetchImpl);

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "no-store",
      "retry-after": "60",
      "x-sentry-rate-limits": "60:error:project",
    });
  });

  it("answers an upstream connection failure with a non-cacheable gateway error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failure"));

    await expectError(
      await handleSentryTunnel(post(envelope()), fetchImpl),
      502,
      "upstream_unavailable",
    );
  });
});

describe("Sentry tunnel request matching", () => {
  it.each(["https://www.fluncle.com", "http://mirror.onion", "http://localhost:3000"])(
    "matches the exact path on %s regardless of method",
    (origin) => {
      expect(isSentryTunnelRequest(new Request(`${origin}${SENTRY_TUNNEL_PATH}`))).toBe(true);
      expect(isSentryTunnelRequest(new Request(`${origin}${SENTRY_TUNNEL_PATH}?anything=1`))).toBe(
        true,
      );
      expect(isSentryTunnelRequest(new Request(`${origin}${SENTRY_TUNNEL_PATH}/`))).toBe(false);
      expect(isSentryTunnelRequest(new Request(`${origin}${SENTRY_TUNNEL_PATH}-other`))).toBe(
        false,
      );
    },
  );
});
