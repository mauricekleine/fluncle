import { describe, expect, it } from "vitest";
import { loadRowsUntil } from "../tests/browser/labels-smoke-pagination";

describe("the labels smoke fixture lookup", () => {
  it("keeps paging until each zz QA fixture is visible past the first 50 rows", async () => {
    for (const fixture of ["zz QA Waiting Label", "zz QA Partial Label"]) {
      const firstPage = Array.from(
        { length: 50 },
        (_, index) => `aa QA Pagination Filler ${String(index + 1).padStart(3, "0")}`,
      );
      const laterPages = [
        Array.from(
          { length: 50 },
          (_, index) => `bb QA Pagination Filler ${String(index + 1).padStart(3, "0")}`,
        ),
        [fixture],
      ];
      let pageReads = 0;

      expect(firstPage.some((row) => row.includes(fixture))).toBe(false);

      const rows = await loadRowsUntil(
        firstPage,
        async () => {
          pageReads += 1;

          return laterPages.shift();
        },
        (row) => row.includes(fixture),
      );

      expect(rows.some((row) => row.includes(fixture))).toBe(true);
      expect(pageReads).toBe(2);
    }
  });
});
