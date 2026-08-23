import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function sweep(name: string): string {
  return readFileSync(join(import.meta.dir, `${name}-sweep.ts`), "utf8");
}

describe("run-level errors stay separate from item-level failures", () => {
  test("crawl reports partial work in `failed` and reserves `errors` for the run catch", () => {
    const source = sweep("crawl");

    expect(source).not.toContain("summary.errors = summary.failed");
    expect(source).toContain("const attemptedFailures = pass.failed ?? 0");
    expect(source).toContain(
      "summary.failed = Math.max(0, attemptedFailures - (pass.rateLimited ? 1 : 0))",
    );
    expect(source).toContain("summary.errors = 1");
  });

  test("enrich reports continued item and arm failures in `failed`", () => {
    const source = sweep("enrich");

    expect(source).not.toContain("summary.errors += 1");
    expect(source.match(/summary\.failed \+= 1/g)).toHaveLength(3);
    expect(source).toContain('{ error: message, errors: 1, ok: false, reason: "enrich_failed" }');
  });

  test("note reports continued item failures in `failed` and a fatal auth run in `errors`", () => {
    const source = sweep("note");

    expect(source).not.toContain("summary.errors += 1");
    expect(source).toContain("summary.failed += 1");
    expect(source).toContain("summary.errors = 1");
    expect(source).toContain('{ errors: 1, ok: false, reason: "sweep_error" }');
  });

  test("note dry-run initializes `failed` and keeps `errors` at zero", () => {
    const source = sweep("note");

    expect(source).toContain("let failed = 0");
    expect(source).not.toContain("let errors = 0");
    expect(source).toContain("errors: 0");
  });

  test("anchor reports continued row/rung failures in `failed`", () => {
    const source = sweep("anchor");

    expect(source).toContain("failed: 0");
    expect(source).toContain("summary.failed += invalidRows");
    expect(source).not.toContain("summary.errors += invalidRows");
    expect(source).toContain("recordFailure(summary");
    expect(source).toContain("recordRunError(summary");
  });

  test("artist adds image item losses to `failed` and reserves `errors` for the fatal boundary", () => {
    const source = sweep("artist");

    expect(source).toContain("errors: 0");
    expect(source).toContain("failed: 0");
    expect(source).toContain("summary.failed += images.failed");
    expect(source).not.toContain("const errors = summary.failed + summary.imagesFailed");
    expect(source).toContain('{ error: message, errors: 1, ok: false, reason: "artist_failed" }');
  });

  test("artist credits sets `errors` only in the catch that exits the run", () => {
    const source = sweep("artist-credits");

    expect(source).toContain("summary.errors = 1");
    expect(source).toContain("if (!summary.ok) {\n    process.exit(1);");
    expect(source).not.toContain("summary.errors = summary.");
  });

  test("capture exposes item failures in `failed` and exits on a run failure", () => {
    const source = sweep("capture");

    expect(source).toContain("failed: counts.failed");
    expect(source).not.toContain("errors: counts.failed");
    expect(source).toContain("export function buildCaptureFatalSummary");
    expect(source).toContain('reason: "capture_failed"');
    expect(source).toContain("errors: 1");
    expect(source).toContain("process.exit(1)");
  });

  test("social metrics adds isolated arm faults to `failed` and keeps `errors` run-level", () => {
    const source = sweep("social-metrics");

    expect(source).toContain("postizFailed + summary.tiktokFailed + summary.youtubeFailed");
    expect(source).not.toContain("summary.errors = summary.failed");
    expect(source).toContain("summary.errors = 1");
  });

  test("reach counts isolated platform faults in `failed` and reserves `errors` for a hard stop", () => {
    const source = sweep("reach");

    expect(source).toContain("summary.failed = tick.failed.length");
    expect(source).not.toContain("summary.errors = summary.failed");
    expect(source).toContain("summary.errors = 1");
  });
});
