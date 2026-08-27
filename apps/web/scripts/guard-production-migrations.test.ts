import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  guardProtectedProductionMigrations,
  hasLegacyOperationReceiptRoute,
  OPERATION_RECEIPT_CALLER_FLOOR_ENV,
  OPERATION_RECEIPT_CALLER_FLOOR_SHA,
  parseMigrationJournal,
  pendingProtectedMigrationTags,
  PROTECTED_CONTRACTION_TAGS,
  PROTECTED_MIGRATION_APPROVAL_ENV,
  readLastAppliedMigrationWhen,
  requireOperationReceiptCallerFloor,
  requireProtectedMigrationApproval,
} from "./guard-production-migrations";

const JOURNAL_JSON = JSON.stringify({
  dialect: "sqlite",
  entries: [
    { breakpoints: true, idx: 0, tag: "0168_safe_expansion", version: "6", when: 100 },
    {
      breakpoints: true,
      idx: 1,
      tag: "0169_lonely_mariko_yashida",
      version: "6",
      when: 200,
    },
    {
      breakpoints: true,
      idx: 2,
      tag: "0170_motionless_squadron_supreme",
      version: "6",
      when: 300,
    },
    { breakpoints: true, idx: 3, tag: "0171_watery_skreet", version: "6", when: 400 },
  ],
  version: "7",
});

const ALL_PROTECTED = PROTECTED_CONTRACTION_TAGS.join(",");
const LEGACY_OPERATION_RECEIPT_CONTRACT = `
export const adminOperationReceiptsContract = {
  get_operation_receipt: getOperationReceipt,
  get_operation_receipt_legacy: getOperationReceiptLegacy,
};
`;
const CONTRACT_WITHOUT_LEGACY_ROUTE = `
export const adminOperationReceiptsContract = {
  get_operation_receipt: getOperationReceipt,
};
`;

describe("operation receipt caller floor", () => {
  it("detects that the checked-out contract has removed the legacy compatibility route", () => {
    const contractSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/contracts/src/orpc/admin-operation-receipts.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(hasLegacyOperationReceiptRoute(contractSource)).toBe(false);
    expect(() =>
      requireOperationReceiptCallerFloor(contractSource, OPERATION_RECEIPT_CALLER_FLOOR_SHA),
    ).not.toThrow();
  });

  it("does not require the caller floor while the legacy route remains in the checkout", () => {
    expect(hasLegacyOperationReceiptRoute(LEGACY_OPERATION_RECEIPT_CONTRACT)).toBe(true);

    for (const callerFloor of [undefined, "", "not-the-floor"]) {
      expect(() =>
        requireOperationReceiptCallerFloor(LEGACY_OPERATION_RECEIPT_CONTRACT, callerFloor),
      ).not.toThrow();
    }
  });

  it("accepts only the exact persistent caller floor after the legacy route is absent", () => {
    expect(() =>
      requireOperationReceiptCallerFloor(
        CONTRACT_WITHOUT_LEGACY_ROUTE,
        OPERATION_RECEIPT_CALLER_FLOOR_SHA,
      ),
    ).not.toThrow();

    for (const callerFloor of [
      undefined,
      "",
      OPERATION_RECEIPT_CALLER_FLOOR_SHA.slice(0, 8),
      ` ${OPERATION_RECEIPT_CALLER_FLOOR_SHA}`,
      `${OPERATION_RECEIPT_CALLER_FLOOR_SHA} `,
      "e44acfb9531d80255eb800fea72f12d1c708ae9b",
    ]) {
      expect(() =>
        requireOperationReceiptCallerFloor(CONTRACT_WITHOUT_LEGACY_ROUTE, callerFloor),
      ).toThrow(new RegExp(OPERATION_RECEIPT_CALLER_FLOOR_ENV));
    }
  });
});

describe("protected production migration journal", () => {
  it("reads the checked-in generated journal and finds the protected tags in exact order", () => {
    const journal = readFileSync(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    );
    const entries = parseMigrationJournal(journal);

    expect(pendingProtectedMigrationTags(entries, null)).toEqual(PROTECTED_CONTRACTION_TAGS);
  });

  it.each([
    "not json",
    JSON.stringify({ dialect: "postgresql", entries: [] }),
    JSON.stringify({ dialect: "sqlite", entries: [{ idx: 1, tag: "0169_bad", when: 1 }] }),
    JSON.stringify({
      dialect: "sqlite",
      entries: [
        { idx: 0, tag: "0169_same", when: 2 },
        { idx: 1, tag: "0169_same", when: 3 },
      ],
    }),
    JSON.stringify({
      dialect: "sqlite",
      entries: [
        { idx: 0, tag: "0169_first", when: 2 },
        { idx: 1, tag: "0170_second", when: 1 },
      ],
    }),
  ])("fails closed on malformed generated journal metadata", (journal) => {
    expect(() => parseMigrationJournal(journal)).toThrow(/production migration guard/);
  });

  it("fails closed if a protected tag is absent or reordered", () => {
    const entries = parseMigrationJournal(JOURNAL_JSON);

    expect(() =>
      pendingProtectedMigrationTags(
        entries.filter((entry) => entry.tag !== "0170_motionless_squadron_supreme"),
        null,
      ),
    ).toThrow(/missing or out of journal order/);
    expect(() =>
      pendingProtectedMigrationTags([entries[0], entries[2], entries[1], entries[3]], null),
    ).toThrow(/missing or out of journal order/);
  });

  it("mirrors Drizzle's latest-created-at rule for all, a suffix, and no pending contractions", () => {
    const entries = parseMigrationJournal(JOURNAL_JSON);

    expect(pendingProtectedMigrationTags(entries, null)).toEqual(PROTECTED_CONTRACTION_TAGS);
    expect(pendingProtectedMigrationTags(entries, 200)).toEqual([
      "0170_motionless_squadron_supreme",
      "0171_watery_skreet",
    ]);
    expect(pendingProtectedMigrationTags(entries, 350)).toEqual(["0171_watery_skreet"]);
    expect(pendingProtectedMigrationTags(entries, 400)).toEqual([]);
    expect(pendingProtectedMigrationTags(entries, 500)).toEqual([]);
  });
});

describe("protected production migration approval", () => {
  it("accepts only the literal pending tag list in journal order", () => {
    expect(() =>
      requireProtectedMigrationApproval(PROTECTED_CONTRACTION_TAGS, ALL_PROTECTED),
    ).not.toThrow();

    for (const approval of [
      undefined,
      "",
      ` ${ALL_PROTECTED}`,
      `${ALL_PROTECTED} `,
      PROTECTED_CONTRACTION_TAGS.slice(0, 2).join(","),
      `${ALL_PROTECTED},0168_safe_expansion`,
      [...PROTECTED_CONTRACTION_TAGS].reverse().join(","),
      `${ALL_PROTECTED},${PROTECTED_CONTRACTION_TAGS[2]}`,
    ]) {
      expect(() => requireProtectedMigrationApproval(PROTECTED_CONTRACTION_TAGS, approval)).toThrow(
        new RegExp(PROTECTED_MIGRATION_APPROVAL_ENV),
      );
    }
  });

  it("lets ordinary deploys pass without approval after the contractions are applied", () => {
    expect(() => requireProtectedMigrationApproval([], undefined)).not.toThrow();
    expect(() => requireProtectedMigrationApproval([], "")).not.toThrow();
  });

  it("rejects a stale approval when no protected contraction is pending", () => {
    expect(() => requireProtectedMigrationApproval([], ALL_PROTECTED)).toThrow(/must be unset/);
  });

  it("inspects the ledger before deciding the exact approval", async () => {
    const readLastAppliedWhen = vi.fn(async () => 200);

    await expect(
      guardProtectedProductionMigrations({
        approval: "0170_motionless_squadron_supreme,0171_watery_skreet",
        journalJson: JOURNAL_JSON,
        readLastAppliedWhen,
      }),
    ).resolves.toEqual({
      lastAppliedWhen: 200,
      pendingTags: ["0170_motionless_squadron_supreme", "0171_watery_skreet"],
    });
    expect(readLastAppliedWhen).toHaveBeenCalledOnce();
  });
});

describe("production migration ledger inspection", () => {
  it("treats an absent ledger table as no applied migration without querying the table", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));

    await expect(readLastAppliedMigrationWhen({ execute } as never)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      sql: expect.stringContaining("sqlite_master"),
    });
  });

  it("reads the greatest created_at coordinate from an existing ledger", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ present: 1 }] })
      .mockResolvedValueOnce({ rows: [{ created_at: "400" }] });

    await expect(readLastAppliedMigrationWhen({ execute } as never)).resolves.toBe(400);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      sql: "select created_at from __drizzle_migrations order by created_at desc limit 1",
    });
  });

  it("treats an existing but empty ledger as no applied migration", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ present: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(readLastAppliedMigrationWhen({ execute } as never)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["", "not-a-timestamp", 0, -1, Number.NaN])(
    "fails closed on unreadable migration ledger state: %s",
    async (createdAt) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ present: 1 }] })
        .mockResolvedValueOnce({ rows: [{ created_at: createdAt }] });

      await expect(readLastAppliedMigrationWhen({ execute } as never)).rejects.toThrow(
        /ledger timestamp is invalid/,
      );
    },
  );
});

describe("production deploy migration boundary", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { scripts: Record<string, string> };

  it("keeps local db:migrate unchanged and puts the guard only in the production wrapper", () => {
    expect(pkg.scripts["db:migrate"]).toBe(
      "drizzle-kit migrate && bun run scripts/ensure-search-index.ts",
    );
    expect(pkg.scripts["db:migrate:production"]).toBe(
      "bun run scripts/guard-production-migrations.ts && bun run db:migrate",
    );
  });

  it("routes deploy:cf through the guarded production migration before backfill and deploy", () => {
    const chain = pkg.scripts["deploy:cf"] ?? "";
    const migrationAt = chain.indexOf("bun run db:migrate:production");
    const backfillAt = chain.indexOf("bun run db:backfill");
    const deployAt = chain.indexOf("wrangler deploy");

    expect(migrationAt).toBe(0);
    expect(backfillAt).toBeGreaterThan(migrationAt);
    expect(deployAt).toBeGreaterThan(backfillAt);
    expect(chain).not.toContain("bun run db:migrate &&");
  });

  it("checks the checked-out compatibility route before constructing a production client", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./guard-production-migrations.ts", import.meta.url)),
      "utf8",
    );
    const contractReadAt = source.indexOf("const operationReceiptContractSource = readFileSync(");
    const callerFloorAt = source.indexOf(
      "const legacyOperationReceiptRoutePresent = requireOperationReceiptCallerFloor(",
    );
    const clientAt = source.indexOf("const client = createClient(");

    expect(source).toContain('"../../../packages/contracts/src/orpc/admin-operation-receipts.ts"');
    expect(contractReadAt).toBeGreaterThanOrEqual(0);
    expect(callerFloorAt).toBeGreaterThan(contractReadAt);
    expect(clientAt).toBeGreaterThan(callerFloorAt);
  });
});
