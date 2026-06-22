import { describe, expect, it } from "vitest";
import { type CursorPage, collectPages } from "./paginate";

// The Galaxy catalogue load must never hang on a misbehaving cursor. These pin
// the guard: it walks normal pages to exhaustion, stops on a repeated cursor,
// and never exceeds the page cap even when the cursor never resolves.

describe("collectPages", () => {
  it("walks every page until the cursor runs out", async () => {
    const pages: Record<string, CursorPage<number>> = {
      "": { items: [1, 2], nextCursor: "a" },
      a: { items: [3, 4], nextCursor: "b" },
      b: { items: [5], nextCursor: undefined },
    };

    const items = await collectPages(async (cursor) => pages[cursor ?? ""], { maxPages: 48 });

    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops when the cursor cycles (non-advancing or repeating)", async () => {
    let calls = 0;
    // A cursor that always points back to itself would loop forever without the
    // cycle guard.
    const items = await collectPages<number>(
      async () => {
        calls += 1;
        return { items: [calls], nextCursor: "stuck" };
      },
      { maxPages: 48 },
    );

    // First page returns nextCursor "stuck"; the second sees it already seen and
    // stops — exactly two fetches, not an infinite loop.
    expect(calls).toBe(2);
    expect(items).toEqual([1, 2]);
  });

  it("never exceeds maxPages even with an always-fresh advancing cursor", async () => {
    let calls = 0;
    const items = await collectPages<number>(
      async () => {
        calls += 1;
        // Every page hands back a brand-new cursor, so only the hard cap stops it.
        return { items: [calls], nextCursor: `page-${calls}` };
      },
      { maxPages: 5 },
    );

    expect(calls).toBe(5);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
