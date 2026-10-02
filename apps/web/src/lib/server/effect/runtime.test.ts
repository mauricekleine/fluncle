import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api-error";
import { runServerEffect } from "./runtime";

class UpstreamDown extends Data.TaggedError("UpstreamDown")<{ status: number }> {}

describe("runServerEffect", () => {
  it("resolves with the effect's value", async () => {
    await expect(runServerEffect(Effect.succeed(42))).resolves.toBe(42);
  });

  it("rejects with the typed failure itself, so callers can match it", async () => {
    const failure = runServerEffect(Effect.fail(new UpstreamDown({ status: 503 })));

    await expect(failure).rejects.toBeInstanceOf(UpstreamDown);
    await expect(failure).rejects.toMatchObject({ _tag: "UpstreamDown", status: 503 });
  });

  it("keeps ApiError identity across the Promise boundary for apiFault", async () => {
    const failure = runServerEffect(Effect.fail(new ApiError("quota", "Quota exceeded", 429)));

    await expect(failure).rejects.toBeInstanceOf(ApiError);
  });
});
