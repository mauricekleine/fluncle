import { describe, expect, it } from "vitest";
import { withRetries } from "./retry";
import { ApiError } from "./spotify";

describe("withRetries", () => {
  it("retries a transient failure, then returns the eventual success", async () => {
    let calls = 0;

    const result = await withRetries("flaky", async () => {
      calls += 1;

      if (calls < 2) {
        throw new Error("transient");
      }

      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  // The reauth signal must survive the retry layer: an expired Spotify token
  // throws an ApiError, and retrying it is both pointless and would flatten the
  // code the caller branches on. withRetries bails on the first ApiError, intact.
  it("does not retry an ApiError and rethrows it with its code intact", async () => {
    let calls = 0;

    const run = withRetries("auth", async () => {
      calls += 1;
      throw new ApiError("spotify_reauth_required", "reconnect", 401);
    });

    await expect(run).rejects.toMatchObject({ code: "spotify_reauth_required", status: 401 });
    expect(calls).toBe(1);
  });
});
