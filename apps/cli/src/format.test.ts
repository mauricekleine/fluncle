import { describe, expect, test } from "bun:test";
import { foundDate, vehicleRows } from "./format";

describe("foundDate", () => {
  test("slices the ISO timestamp down to the Found date", () => {
    expect(foundDate("2026-06-06T13:59:09.922Z")).toBe("2026-06-06");
  });
});

describe("vehicleRows", () => {
  test("renders `<logId>  <date>  <vehicle>  ·  <register>` with a padded coordinate column", () => {
    const rows = vehicleRows([
      {
        addedAt: "2026-06-06T13:59:09.922Z",
        logId: "007.8.1B",
        register: "abstract",
        vehicle: "caustic membrane",
      },
      {
        addedAt: "2026-06-03T15:13:05.714Z",
        logId: "004.6.0K",
        register: "framed",
        vehicle: "billowing drape",
      },
    ]);

    expect(rows).toEqual([
      "007.8.1B  2026-06-06  caustic membrane  ·  abstract",
      "004.6.0K  2026-06-03  billowing drape  ·  framed",
    ]);
  });

  test("falls back to an em dash when a finding has no coordinate, vehicle, or register", () => {
    const rows = vehicleRows([{ addedAt: "2026-06-06T13:59:09.922Z" }]);

    expect(rows).toEqual(["—  2026-06-06  —  ·  —"]);
  });
});
