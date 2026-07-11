// Unit tests for the pure helpers in embed-batch.ts — the GPU-batch orchestrator is
// self-contained (a rented pod cannot import the workspace) and lives outside any package's
// test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/embed-batch.test.ts

import { describe, expect, it } from "bun:test";

import { mapWithConcurrency, parseBatchArgs, sourceAudioExt } from "./embed-batch";

// The GPU batch's pure helpers. `main()` is guarded behind `import.meta.main`, so importing
// this module spawns no python, rents no GPU, and touches no R2 — the tests are hermetic.

describe("parseBatchArgs", () => {
  it("defaults to a safe, small, non-destructive batch", () => {
    // A bare invocation must never be the expensive one: the pod bills by the minute.
    expect(parseBatchArgs([])).toEqual({ dryRun: false, limit: 50, scope: "all" });
  });

  it("clamps --limit to the server's own ceiling", () => {
    // A fat-fingered `--limit 100000` cannot ask for a page the API would refuse — nor rent
    // GPU time downloading an archive nobody asked for.
    expect(parseBatchArgs(["--limit", "100000"]).limit).toBe(200);
    expect(parseBatchArgs(["--limit", "0"]).limit).toBe(50); // non-positive → the default
    expect(parseBatchArgs(["--limit", "nonsense"]).limit).toBe(50);
    expect(parseBatchArgs(["--limit", "120"]).limit).toBe(120);
  });

  it("takes only the three real scopes, ignoring anything else", () => {
    expect(parseBatchArgs(["--scope", "catalogue"]).scope).toBe("catalogue");
    expect(parseBatchArgs(["--scope", "findings"]).scope).toBe("findings");
    expect(parseBatchArgs(["--scope", "everything"]).scope).toBe("all");
  });

  it("carries --dry-run, the answer-without-spending flag", () => {
    const args = parseBatchArgs(["--dry-run", "--limit", "10", "--scope", "catalogue"]);

    expect(args).toEqual({ dryRun: true, limit: 10, scope: "catalogue" });
  });
});

describe("sourceAudioExt", () => {
  it("carries the captured container's suffix onto the temp file", () => {
    expect(sourceAudioExt("004.7.2I/abc123.webm")).toBe(".webm");
    expect(sourceAudioExt("004.7.2I/abc123.M4A")).toBe(".m4a");
  });

  it("falls back to .audio when the key carries no usable extension", () => {
    // ffmpeg decodes by CONTENT, so this is hygiene, not correctness — but a temp file with a
    // trailing dot (or a bare key) must not produce a nonsense filename.
    expect(sourceAudioExt("004.7.2I/abc123")).toBe(".audio");
    expect(sourceAudioExt("004.7.2I/abc123.")).toBe(".audio");
    expect(sourceAudioExt("bare-key")).toBe(".audio");
  });
});

describe("mapWithConcurrency", () => {
  it("runs every item and keeps the results positionally aligned", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the requested width", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;

        return n;
      },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("yields null for a failed item and finishes the rest — one dead object cannot sink the batch", async () => {
    // A key whose R2 object went missing must cost that ONE track, not the whole (billed) pass.
    // The track simply stays queued and the next run picks it up.
    const results = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) {
        throw new Error("R2 GET failed (404)");
      }

      return n * 10;
    });

    expect(results).toEqual([10, null, 30]);
  });

  it("is a no-op on an empty worklist (it never even starts a worker)", async () => {
    let calls = 0;

    const results = await mapWithConcurrency<number, number>([], 8, async (n) => {
      calls += 1;

      return n;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
