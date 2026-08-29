import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  parseMigrationJournal,
  planPendingProductionMigrations,
  planProductionMigrations,
  readLastAppliedMigrationWhen,
} from "./guard-production-migrations";

const JOURNAL_JSON = JSON.stringify({
  dialect: "sqlite",
  entries: [
    { breakpoints: true, idx: 0, tag: "0168_expansion", version: "6", when: 100 },
    { breakpoints: true, idx: 1, tag: "0169_contraction", version: "6", when: 200 },
    { breakpoints: true, idx: 2, tag: "0170_contraction", version: "6", when: 300 },
    { breakpoints: true, idx: 3, tag: "0171_contraction", version: "6", when: 400 },
    { breakpoints: true, idx: 4, tag: "0172_expansion", version: "6", when: 500 },
  ],
  version: "7",
});

const ENTRIES = parseMigrationJournal(JOURNAL_JSON);

describe("production migration journal", () => {
  it("parses the complete checked-in journal in generated order", () => {
    const journal = readFileSync(
      fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    );
    const entries = parseMigrationJournal(journal);

    expect(entries.at(-1)?.tag).toBe("0173_brief_ben_urich");
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
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

  it("fails closed when generated entries are reordered", () => {
    const reordered = ENTRIES.map((entry) => ({ ...entry }));
    const second = reordered[1];
    const third = reordered[2];
    if (!second || !third) {
      throw new Error("fixture requires at least three migration entries");
    }
    reordered[1] = { ...third, idx: 1 };
    reordered[2] = { ...second, idx: 2 };

    const journal = JSON.stringify({ dialect: "sqlite", entries: reordered, version: "7" });
    expect(() => parseMigrationJournal(journal)).toThrow(/journal entry \d+ is invalid/);
  });
});

describe("production migration planning", () => {
  it("plans the complete journal suffix above the ledger maximum", () => {
    const plan = planProductionMigrations(ENTRIES, 100);

    expect(plan).toEqual({
      lastAppliedWhen: 100,
      pendingEntries: ENTRIES.slice(1),
      throughTag: "0172_expansion",
    });
  });

  it("returns an empty plan when the target is current", () => {
    expect(planProductionMigrations(ENTRIES, 500)).toEqual({
      lastAppliedWhen: 500,
      pendingEntries: [],
      throughTag: null,
    });
  });

  it("inspects the ledger before planning the pending suffix", async () => {
    const readLastAppliedWhen = vi.fn(async () => 300);

    await expect(
      planPendingProductionMigrations({ journalJson: JOURNAL_JSON, readLastAppliedWhen }),
    ).resolves.toEqual({
      lastAppliedWhen: 300,
      pendingEntries: ENTRIES.slice(3),
      throughTag: "0172_expansion",
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

  it("keeps local migration unchanged and gives production one complete journal command", () => {
    expect(pkg.scripts["db:migrate"]).toBe(
      "drizzle-kit migrate && bun run scripts/ensure-search-index.ts",
    );
    expect(pkg.scripts["db:migrate:production"]).toBe(
      "bun run scripts/migrate.ts && bun run scripts/ensure-search-index.ts",
    );
    expect(pkg.scripts["db:migrate:production:h4"]).toBeUndefined();
    expect(pkg.scripts["db:migrate:production:h8"]).toBeUndefined();
  });

  it("routes deploy:cf through the complete pending journal before backfill and deploy", () => {
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
