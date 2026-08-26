import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";

const gets: string[] = [];
const posts: { body: unknown; path: string }[] = [];

const response = {
  ok: true as const,
  receipt: {
    createdAt: "2026-08-26T10:00:00.000Z",
    operationId: "health.snapshot",
    outcome: "committed" as const,
    resultIdentity: "health.snapshot:2026-08-26T10:00:00.000Z",
    state: "committed" as const,
    terminalAt: "2026-08-26T10:00:01.000Z",
    updatedAt: "2026-08-26T10:00:01.000Z",
  },
};

await mock.module("../api", () => ({
  ...realApi,
  adminApiGet: async (path: string) => {
    gets.push(path);
    return response;
  },
  adminApiPost: async (path: string, body: unknown) => {
    posts.push({ body, path });
    return { ok: true, repaired: 2, scanned: 2 };
  },
}));

const {
  getOperationReceiptCommand,
  operationReceiptLines,
  parseOperationReceiptFence,
  parseOperationReceiptRepairLimit,
  repairOperationReceiptsCommand,
} = await import("./admin-operation-receipts");

beforeEach(() => {
  gets.length = 0;
  posts.length = 0;
});

describe("operation receipt commands", () => {
  test("encodes the operation key and sends only the bounded repair fence", async () => {
    expect(await Promise.resolve(getOperationReceiptCommand("health.snapshot:one/two"))).toBe(
      response,
    );
    expect(
      await Promise.resolve(
        repairOperationReceiptsCommand({
          limit: 2,
          staleBefore: "2026-08-26T10:00:00.000Z",
        }),
      ),
    ).toEqual({ ok: true, repaired: 2, scanned: 2 });

    expect(gets).toEqual(["/api/v1/admin/operation-receipts/health.snapshot%3Aone%2Ftwo"]);
    expect(posts).toEqual([
      {
        body: { limit: 2, staleBefore: "2026-08-26T10:00:00.000Z" },
        path: "/api/v1/admin/operation-receipts/reconcile",
      },
    ]);
  });

  test("validates the repair bound and timestamp before transport", () => {
    expect(parseOperationReceiptRepairLimit("100")).toBe(100);
    expect(() => parseOperationReceiptRepairLimit("101")).toThrow(/1 through 100/);
    expect(() => parseOperationReceiptRepairLimit("1.5")).toThrow(/whole number/);
    expect(parseOperationReceiptFence("2026-08-26T12:00:00+02:00")).toBe(
      "2026-08-26T10:00:00.000Z",
    );
    expect(() => parseOperationReceiptFence("2026-08-26T12:00:00")).toThrow(/explicit offset/);
  });

  test("prints bounded receipt metadata without request or result payloads", () => {
    const lines = operationReceiptLines(response.receipt);

    expect(lines).toEqual([
      "Outcome: committed",
      "Operation: health.snapshot",
      "State: committed",
      "Result: health.snapshot:2026-08-26T10:00:00.000Z",
      "Updated: 2026-08-26T10:00:01.000Z",
    ]);
    expect(lines.join("\n")).not.toMatch(/digest|payload|request/i);
  });
});
