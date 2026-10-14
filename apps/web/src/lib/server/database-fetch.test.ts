import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  span: undefined as undefined | ReturnType<typeof recordingSpan>,
}));
vi.mock("@sentry/core", () => ({ getActiveSpan: () => state.span }));

import { databaseFetch } from "./database-fetch";

function recordingSpan() {
  return { isRecording: () => true, setAttribute: vi.fn() };
}

afterEach(() => {
  state.span = undefined;
  vi.unstubAllGlobals();
});

describe("database response byte attribution", () => {
  it("preserves streamed bytes and accumulates consumed response bodies on their originating span", async () => {
    const first = recordingSpan();
    const second = recordingSpan();
    state.span = first;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([65, 66]));
                controller.enqueue(new Uint8Array([67]));
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" }, status: 201 },
          ),
      ),
    );
    const response = await databaseFetch("https://database.invalid");
    state.span = second;
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe("ABC");
    expect(first.setAttribute).toHaveBeenLastCalledWith("fluncle.response_body_bytes", 3);
    expect(second.setAttribute).not.toHaveBeenCalled();
    state.span = first;
    expect(await (await databaseFetch("https://database.invalid")).text()).toBe("ABC");
    expect(first.setAttribute).toHaveBeenCalledWith("fluncle.response_count", 2);
    expect(first.setAttribute).toHaveBeenLastCalledWith("fluncle.response_body_bytes", 6);
  });

  it("leaves untraced responses untouched and preserves fetch failures", async () => {
    const original = new Response("untraced");
    const failure = new Error("transport failed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(original).mockRejectedValueOnce(failure));
    expect(await databaseFetch("https://database.invalid")).toBe(original);
    await expect(databaseFetch("https://database.invalid")).rejects.toBe(failure);
  });

  it("propagates stream failures after recording the consumed prefix", async () => {
    state.span = recordingSpan();
    let chunks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (chunks++ === 0) {
                  controller.enqueue(new Uint8Array([65, 66]));
                } else {
                  controller.error(new Error("body failed"));
                }
              },
            }),
          ),
      ),
    );
    await expect((await databaseFetch("https://database.invalid")).text()).rejects.toThrow(
      "body failed",
    );
    expect(state.span.setAttribute).toHaveBeenCalledWith("fluncle.response_body_bytes", 2);
  });
});
