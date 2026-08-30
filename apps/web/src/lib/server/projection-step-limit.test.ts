import { PROJECTION_STEP_LIMIT_MAX } from "@fluncle/contracts/orpc";
import { describe, expect, it } from "vitest";

import { MAX_DUE_WORK_CHUNK_SIZE } from "./due-work";

/**
 * The projection step ceiling and the due-work chunk bound live in two packages, and the operator
 * control plane hands one straight to the other: `advance_projection --target track_due_work
 * --action rebuild --limit N` flows through `advanceProjectionFor` into `runDueWorkRebuildChunk`,
 * whose `assertLimit` rejects anything above `MAX_DUE_WORK_CHUNK_SIZE`. A contract ceiling above
 * that bound is therefore a request the contract accepts and the server refuses — a 500 on a
 * limit the CLI advertised as valid. Raising either constant requires raising the other.
 */
describe("projection step limit", () => {
  it("never advertises a step limit the due-work chunk bound refuses", () => {
    expect(PROJECTION_STEP_LIMIT_MAX).toBeLessThanOrEqual(MAX_DUE_WORK_CHUNK_SIZE);
  });

  it("keeps the advertised ceiling a usable positive integer", () => {
    expect(Number.isSafeInteger(PROJECTION_STEP_LIMIT_MAX)).toBe(true);
    expect(PROJECTION_STEP_LIMIT_MAX).toBeGreaterThanOrEqual(1);
  });
});
