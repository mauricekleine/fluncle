import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  EXPANSION_CEILING_TAG,
  guardProtectedProductionMigrations,
  parseMigrationJournal,
  pendingProtectedMigrationTags,
  planProductionMigrations,
  PROTECTED_CONTRACTION_TAGS,
  PROTECTED_MIGRATION_APPROVAL_ENV,
  readLastAppliedMigrationWhen,
  requireProtectedMigrationApproval,
} from "./guard-production-migrations";

const JOURNAL_JSON = JSON.stringify({
  dialect: "sqlite",
  entries: [
    { breakpoints: true, idx: 0, tag: EXPANSION_CEILING_TAG, version: "6", when: 100 },
    {
      breakpoints: true,
      idx: 1,
      tag: PROTECTED_CONTRACTION_TAGS[0],
      version: "6",
      when: 200,
    },
    {
      breakpoints: true,
      idx: 2,
      tag: PROTECTED_CONTRACTION_TAGS[1],
      version: "6",
      when: 300,
    },
    {
      breakpoints: true,
      idx: 3,
      tag: PROTECTED_CONTRACTION_TAGS[2],
      version: "6",
      when: 400,
    },
    { breakpoints: true, idx: 4, tag: "0172_future_expansion", version: "6", when: 500 },
  ],
  version: "7",
});

const ENTRIES = parseMigrationJournal(JOURNAL_JSON);
const H4_APPROVAL = PROTECTED_CONTRACTION_TAGS.slice(0, 2).join(",");
const H8_APPROVAL = PROTECTED_CONTRACTION_TAGS[2];

describe("protected production migration journal", () => {
  it("finds the checked-in expansion ceiling and protected tags in exact contiguous order", () => {
    const journal = readFileSync(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    );
    const entries = parseMigrationJournal(journal);

    expect(entries.find((entry) => entry.tag === EXPANSION_CEILING_TAG)).toBeDefined();
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

  it("fails closed if the expansion ceiling or a protected tag is absent, reordered, or split", () => {
    expect(() =>
      pendingProtectedMigrationTags(
        ENTRIES.filter((entry) => entry.tag !== PROTECTED_CONTRACTION_TAGS[1]),
        null,
      ),
    ).toThrow(/missing or out of journal order/);
    expect(() =>
      pendingProtectedMigrationTags(
        [ENTRIES[0], ENTRIES[2], ENTRIES[1], ...ENTRIES.slice(3)],
        null,
      ),
    ).toThrow(/missing or out of journal order/);

    const splitEntries = ENTRIES.map((entry) => ({ ...entry }));
    splitEntries.splice(2, 0, { idx: 2, tag: "0169_unprotected_gap", when: 250 });
    splitEntries.forEach((entry, idx) => {
      entry.idx = idx;
    });
    expect(() => pendingProtectedMigrationTags(splitEntries, null)).toThrow(
      /missing or out of journal order/,
    );
  });
});

describe("phase-bounded production migration planning", () => {
  it("lets an ordinary deploy apply expansions while holding every pending contraction", () => {
    const plan = planProductionMigrations({
      approval: undefined,
      entries: ENTRIES,
      lastAppliedWhen: null,
      phase: "deploy",
    });

    expect(plan.throughTag).toBe(EXPANSION_CEILING_TAG);
    expect(plan.pendingEntries.map((entry) => entry.tag)).toEqual([EXPANSION_CEILING_TAG]);
    expect(plan.pendingProtectedTags).toEqual([]);
    expect(plan.blockedProtectedTags).toEqual(PROTECTED_CONTRACTION_TAGS);
  });

  it("rejects a protected approval on the ordinary deploy path", () => {
    expect(() =>
      planProductionMigrations({
        approval: H4_APPROVAL,
        entries: ENTRIES,
        lastAppliedWhen: 100,
        phase: "deploy",
      }),
    ).toThrow(new RegExp(PROTECTED_MIGRATION_APPROVAL_ENV));
  });

  it("continues with later expansions once every protected contraction is applied", () => {
    const plan = planProductionMigrations({
      approval: undefined,
      entries: ENTRIES,
      lastAppliedWhen: 400,
      phase: "deploy",
    });

    expect(plan.throughTag).toBe("0172_future_expansion");
    expect(plan.pendingEntries.map((entry) => entry.tag)).toEqual(["0172_future_expansion"]);
    expect(plan.blockedProtectedTags).toEqual([]);
  });

  it("bounds H4 at 0170 and requires exactly its pending protected prefix", () => {
    const plan = planProductionMigrations({
      approval: H4_APPROVAL,
      entries: ENTRIES,
      lastAppliedWhen: 100,
      phase: "h4",
    });

    expect(plan.throughTag).toBe(PROTECTED_CONTRACTION_TAGS[1]);
    expect(plan.pendingProtectedTags).toEqual(PROTECTED_CONTRACTION_TAGS.slice(0, 2));
    expect(plan.blockedProtectedTags).toEqual([PROTECTED_CONTRACTION_TAGS[2]]);
    expect(plan.pendingEntries.map((entry) => entry.tag)).not.toContain(
      PROTECTED_CONTRACTION_TAGS[2],
    );
  });

  it("requires expansion through 0168 before H4 and H4 through 0170 before H8", () => {
    expect(() =>
      planProductionMigrations({
        approval: H4_APPROVAL,
        entries: ENTRIES,
        lastAppliedWhen: null,
        phase: "h4",
      }),
    ).toThrow(new RegExp(EXPANSION_CEILING_TAG));
    expect(() =>
      planProductionMigrations({
        approval: H8_APPROVAL,
        entries: ENTRIES,
        lastAppliedWhen: 200,
        phase: "h8",
      }),
    ).toThrow(new RegExp(PROTECTED_CONTRACTION_TAGS[1]));
  });

  it("bounds H8 at 0171 and accepts only its one pending tag", () => {
    const plan = planProductionMigrations({
      approval: H8_APPROVAL,
      entries: ENTRIES,
      lastAppliedWhen: 300,
      phase: "h8",
    });

    expect(plan.throughTag).toBe(PROTECTED_CONTRACTION_TAGS[2]);
    expect(plan.pendingProtectedTags).toEqual([PROTECTED_CONTRACTION_TAGS[2]]);
    expect(plan.pendingEntries.map((entry) => entry.tag)).toEqual([PROTECTED_CONTRACTION_TAGS[2]]);
  });

  it("requires the literal pending tag list and rejects stale approvals", () => {
    expect(() =>
      requireProtectedMigrationApproval(PROTECTED_CONTRACTION_TAGS.slice(0, 2), H4_APPROVAL),
    ).not.toThrow();

    for (const approval of [
      undefined,
      "",
      ` ${H4_APPROVAL}`,
      `${H4_APPROVAL} `,
      PROTECTED_CONTRACTION_TAGS[0],
      PROTECTED_CONTRACTION_TAGS.slice(0, 2).reverse().join(","),
    ]) {
      expect(() =>
        requireProtectedMigrationApproval(PROTECTED_CONTRACTION_TAGS.slice(0, 2), approval),
      ).toThrow(new RegExp(PROTECTED_MIGRATION_APPROVAL_ENV));
    }

    expect(() => requireProtectedMigrationApproval([], H8_APPROVAL)).toThrow(/must be unset/);
  });

  it("inspects the ledger before deciding the phase plan", async () => {
    const readLastAppliedWhen = vi.fn(async () => 300);

    await expect(
      guardProtectedProductionMigrations({
        approval: H8_APPROVAL,
        journalJson: JOURNAL_JSON,
        phase: "h8",
        readLastAppliedWhen,
      }),
    ).resolves.toMatchObject({
      lastAppliedWhen: 300,
      pendingProtectedTags: [PROTECTED_CONTRACTION_TAGS[2]],
      phase: "h8",
      throughTag: PROTECTED_CONTRACTION_TAGS[2],
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

  it("keeps local db:migrate unchanged and uses fixed phases only in production commands", () => {
    expect(pkg.scripts["db:migrate"]).toBe(
      "drizzle-kit migrate && bun run scripts/ensure-search-index.ts",
    );
    expect(pkg.scripts["db:migrate:production"]).toContain("scripts/migrate.ts --phase deploy");
    expect(pkg.scripts["db:migrate:production:h4"]).toContain("scripts/migrate.ts --phase h4");
    expect(pkg.scripts["db:migrate:production:h8"]).toContain("scripts/migrate.ts --phase h8");
  });

  it("routes deploy:cf through the bounded deploy phase before backfill and deploy", () => {
    const chain = pkg.scripts["deploy:cf"] ?? "";
    const migrationAt = chain.indexOf("bun run db:migrate:production");
    const backfillAt = chain.indexOf("bun run db:backfill");
    const deployAt = chain.indexOf("wrangler deploy");

    expect(migrationAt).toBe(0);
    expect(backfillAt).toBeGreaterThan(migrationAt);
    expect(deployAt).toBeGreaterThan(backfillAt);
    expect(chain).not.toContain("bun run db:migrate &&");
  });

  it("keeps the standalone deploy command migration-free", () => {
    const chain = pkg.scripts.deploy ?? "";

    expect(chain.indexOf("bun run build")).toBe(0);
    expect(chain).not.toContain("db:migrate");
  });
});
