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
    expect(source).toContain("summary.failed = pass.failed ?? 0");
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
    expect(source).toContain('{ error: message, ok: false, reason: "capture_failed" }');
    expect(source).toContain("process.exit(1)");
  });
});
