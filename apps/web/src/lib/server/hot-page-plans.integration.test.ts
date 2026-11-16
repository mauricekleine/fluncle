import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Client, type InStatement } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createIntegrationDb } from "./integration-db";
import { hotPagePlanRegistry } from "../../../scripts/db-performance/hot-page-plans";
import { applyHotPageStatistics } from "../../../scripts/db-performance/hot-page-statistics";
import { analyzeExplainPlan } from "../../../scripts/db-performance/plan";
import {
  type PerformanceContract,
  type PerformanceStatement,
  runPerformanceContracts,
} from "../../../scripts/db-performance/registry";

const captured: PerformanceStatement[] = [];
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDb: () =>
      Promise.resolve({
        execute: async (statement: InStatement) => {
          if (typeof statement === "string" || !Array.isArray(statement.args)) {
            throw new Error("hot page capture requires positional bound SQL");
          }
          captured.push({ args: statement.args, sql: statement.sql });
          return { rows: [] };
        },
      }),
  };
});

let db: Client;
let contracts: PerformanceContract[];
beforeAll(async () => {
  db = await createIntegrationDb();
  const registry = await hotPagePlanRegistry(async (read) => {
    captured.length = 0;
    await read();
    return [...captured];
  });
  contracts = registry.list();
});
afterAll(() => db?.close());

for (const statistics of ["absent", "representative"] as const) {
  describe(`hot public page plans with ${statistics} statistics`, () => {
    beforeAll(async () => {
      if (statistics === "representative") {
        await applyHotPageStatistics(db);
      }
    });
    it("keeps every registered read on its selective access paths with all current indexes", async () => {
      const statisticsTable = await db.execute(
        "SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'",
      );
      expect(statisticsTable.rows.length).toBe(statistics === "absent" ? 0 : 1);
      const report = await runPerformanceContracts({ client: db, contracts, profile: "1x" });
      expect(
        report.contracts.flatMap(
          (c) => c.plan?.violations.map((v) => `${c.contractId}: ${v}`) ?? [],
        ),
      ).toEqual([]);
      expect(report.passed).toBe(true);
    });
    it("rejects the artist-band catalogue-range search under competing statistics", async () => {
      const contract = contracts.find(
        (c) => c.id === "hot-page.track.artist-band.exclude-record.1",
      );
      if (!contract?.plan) {
        throw new Error("artist band plan contract missing");
      }
      const statement = contract.plan.statement;
      const result = await db.execute({
        ...statement,
        sql: `EXPLAIN QUERY PLAN ${statement.sql.replace(/indexed by sqlite_autoindex_tracks_1/i, "indexed by tracks_sitemap_indexable_cover_idx")}`,
      });
      const details = result.rows.map((r) => {
        if (typeof r.detail !== "string") {
          throw new Error("EXPLAIN row has no detail");
        }
        return r.detail;
      });
      const analysis = analyzeExplainPlan(details, contract.plan.policy);
      expect(analysis.violations).toContainEqual(
        expect.stringContaining("forbidden access path for tracks:"),
      );
      expect(details).toContainEqual(
        expect.stringMatching(
          /SEARCH tracks USING COVERING INDEX tracks_sitemap_indexable_cover_idx \(duplicate_of_track_id=\? AND dismissed_at=\?\)/i,
        ),
      );
    });
  });
}

it("catches the unpinned artist band with the track-id-extended sitemap index", async () => {
  const contract = contracts.find((c) => c.id === "hot-page.track.artist-band.exclude-record.1");
  if (!contract?.plan) {
    throw new Error("artist band plan contract missing");
  }
  const statement = contract.plan.statement;
  const unpinned = {
    ...statement,
    sql: statement.sql.replace(/indexed by sqlite_autoindex_tracks_1/i, ""),
  };
  const scratch = await createIntegrationDb();
  try {
    const report = await runPerformanceContracts({
      client: scratch,
      contracts: [{ ...contract, plan: { ...contract.plan, statement: unpinned } }],
      profile: "1x",
    });
    expect(report.passed).toBe(false);
    const details = report.contracts[0]?.plan?.details ?? [];
    expect(analyzeExplainPlan(details, contract.plan.policy).violations).toContainEqual(
      expect.stringContaining("forbidden access path for tracks:"),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /tracks_sitemap_indexable_cover_idx \(duplicate_of_track_id=\? AND dismissed_at=\?\)/i,
      ),
    );
  } finally {
    scratch.close();
  }
});

it("selects the full web test lane for competing-index and migration changes", () => {
  const selections = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { classifyPaths } from "./scripts/quality/classifier.mjs";
     import { commandsForLane } from "./scripts/quality/run-lane.mjs";
     process.stdout.write(JSON.stringify(process.argv.slice(1).map(file => {
       const plan = classifyPaths([file]);
       return {packages:plan.packages, commands:commandsForLane(plan, "packages")};
     })));`,
        "apps/web/src/db/schema.ts",
        "apps/web/drizzle/0204_fearless_nighthawk.sql",
      ],
      { cwd: fileURLToPath(new URL("../../../../../", import.meta.url)), encoding: "utf8" },
    ),
  ) as { packages: string[]; commands: { args: string[] }[] }[];
  for (const selection of selections) {
    expect(selection.packages).toContain("@fluncle/web");
    expect(selection.commands).toContainEqual(
      expect.objectContaining({ args: expect.arrayContaining(["test", "--filter=@fluncle/web"]) }),
    );
    expect(
      selection.commands.every((command) =>
        command.args.every((arg) => !arg.startsWith("--changed")),
      ),
    ).toBe(true);
  }
});
