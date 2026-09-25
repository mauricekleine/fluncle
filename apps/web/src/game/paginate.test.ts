import { describe, expect, it } from "vitest";
import { type CursorPage, collectPages } from "./paginate";

describe("collectPages", () => {
  it("walks every page until the cursor runs out", async () => {
    const pages: Record<string, CursorPage<number>> = {
      "": { items: [1, 2], nextCursor: "a" },
      a: { items: [3, 4], nextCursor: "b" },
      b: { items: [5], nextCursor: undefined },
    };

    const items = await collectPages(
      async (cursor) => {
        const page = pages[cursor ?? ""];
        if (page === undefined) {
          throw new Error(`no page for cursor ${cursor ?? ""}`);
        }
        return page;
      },
      { maxPages: 48 },
    );

    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops when the cursor cycles (non-advancing or repeating)", async () => {
    let calls = 0;

    const items = await collectPages<number>(
      async () => {
        calls += 1;
        return { items: [calls], nextCursor: "stuck" };
      },
      { maxPages: 48 },
    );

    expect(calls).toBe(2);
    expect(items).toEqual([1, 2]);
  });

  it("never exceeds maxPages even with an always-fresh advancing cursor", async () => {
    let calls = 0;
    const items = await collectPages<number>(
      async () => {
        calls += 1;

        return { items: [calls], nextCursor: `page-${calls}` };
      },
      { maxPages: 5 },
    );

    expect(calls).toBe(5);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});
