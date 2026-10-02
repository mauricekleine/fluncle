import { describe, expect, it } from "vitest";
import { withRetries } from "./retry";
import { ApiError } from "./api-error";

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

  it("does not retry an ApiError and rethrows it with its code intact", async () => {
    let calls = 0;

    const run = withRetries("auth", async () => {
      calls += 1;
      throw new ApiError("spotify_reauth_required", "reconnect", 401);
    });

    await expect(run).rejects.toMatchObject({ code: "spotify_reauth_required", status: 401 });
    expect(calls).toBe(1);
  });

  it("stops immediately on QUOTA_EXCEEDED and names the deferred playlist write", async () => {
    let calls = 0;
    await expect(
      withRetries("Spotify playlist add", async () => {
        calls += 1;
        throw Object.assign(new Error("Spotify API request failed: 429 QUOTA_EXCEEDED"), {
          quotaExceeded: true,
        });
      }),
    ).rejects.toThrow(/Spotify playlist add deferred: Spotify quota exceeded/);
    expect(calls).toBe(1);
  });
});
