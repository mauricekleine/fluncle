import { describe, expect, it } from "vitest";
import { readError } from "./read-error";

function textResponse(body: string, status = 500, statusText = ""): Response {
  return new Response(body, { status, statusText });
}

describe("readError", () => {
  it("prefers the API's own JSON message", async () => {
    const response = Response.json(
      { code: "track_not_found", message: "No such track." },
      {
        status: 404,
      },
    );

    await expect(readError(response)).resolves.toBe("No such track.");
  });

  it("leaves the original body readable — it reads a clone", async () => {
    const response = Response.json({ message: "No such track." }, { status: 404 });

    await expect(readError(response)).resolves.toBe("No such track.");

    await expect(response.json()).resolves.toEqual({ message: "No such track." });
  });

  it("falls through a blank JSON message to the body text", async () => {
    const response = Response.json({ message: "   " }, { status: 502 });

    await expect(readError(response)).resolves.toBe('{"message":"   "}');
  });

  it("falls through a non-string JSON message to the body text", async () => {
    const response = Response.json({ message: { nested: true } }, { status: 502 });

    await expect(readError(response)).resolves.toBe('{"message":{"nested":true}}');
  });

  it("falls back to the raw body text when the body is not JSON", async () => {
    const response = textResponse("upstream refused the connection", 502);

    await expect(readError(response)).resolves.toBe("upstream refused the connection");
  });

  it("trims the raw body text", async () => {
    const response = textResponse("  gateway timeout\n", 504);

    await expect(readError(response)).resolves.toBe("gateway timeout");
  });

  it("falls back to the status line when the body is empty", async () => {
    const response = textResponse("", 503, "Service Unavailable");

    await expect(readError(response)).resolves.toBe("Service Unavailable");
  });

  it("falls back to the status code when there is no body and no status text", async () => {
    const response = textResponse("   ", 418, "");

    await expect(readError(response)).resolves.toBe("Request failed (418)");
  });

  it("still reports when the body itself faults mid-read", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("stream died"));
        },
      }),
      { status: 500, statusText: "Internal Server Error" },
    );

    await expect(readError(response)).resolves.toBe("Internal Server Error");
  });
});
