import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  auditDueWorkDelegatedCallSites,
  auditDueWorkMutationSites,
  auditGoalDMutationSites,
  DUE_WORK_ELIGIBILITY_TABLES,
} from "./due-work-producer-audit";
import {
  DUE_WORK_PRODUCER_INVENTORY,
  DUE_WORK_REVIEWED_NONPRODUCER_WRITERS,
  GOAL_D_REVIEWED_NONPROJECTION_WRITERS,
} from "./due-work-producer-inventory";

const SERVER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIRECTORY = join(SERVER_DIRECTORY, "../../../scripts");
const MAINTENANCE_HELPERS = new Set([
  "batchDueWorkSourceMutation",
  "markDueWorkSourceRepairsFromSelectStatement",
  "markDueWorkSourceRepairsStatement",
]);
type MaintenanceCall = { file: string; producer: string };
type ProductionSource = { file: string; path: string };

async function sourceFiles(directory: string, prefix: string): Promise<ProductionSource[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<ProductionSource[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path, prefix);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }
      return [
        {
          file:
            prefix === ""
              ? entry.name
              : `${prefix}/${relative(SCRIPTS_DIRECTORY, path).replaceAll("\\", "/")}`,
          path,
        },
      ];
    }),
  );
  return files.flat();
}

async function productionSources(): Promise<ProductionSource[]> {
  return [
    ...(await sourceFiles(SERVER_DIRECTORY, "")),
    ...(await sourceFiles(SCRIPTS_DIRECTORY, "scripts")),
  ];
}

function maintenanceCalls(file: string, sourceText: string): MaintenanceCall[] {
  const calls: MaintenanceCall[] = [];
  const producerPattern = /producer:\s*"([^"]+)"/g;

  for (const match of sourceText.matchAll(producerPattern)) {
    const producer = match[1];
    const matchIndex = match.index;
    if (producer === undefined || matchIndex === undefined) {
      continue;
    }

    const prefix = sourceText.slice(0, matchIndex);
    const helper = [...MAINTENANCE_HELPERS]
      .map((name) => ({ index: prefix.lastIndexOf(`${name}(`), name }))
      .sort((left, right) => right.index - left.index)[0];

    if (helper === undefined || helper.index < 0) {
      calls.push({ file, producer });
      continue;
    }

    calls.push({ file, producer });
  }
  return calls;
}

describe("due-work producer maintenance inventory", () => {
  it("rejects an unguarded mutation added to an already-inventoried producer module", () => {
    const sites = auditDueWorkMutationSites(
      "artists.ts",
      `async function write(db: Db) {
        await batchDueWorkSourceMutation(db, [
          { sql: "update artists set bio = ? where id = ?" },
        ], subjects, { producer: "artist-bio-fill" });
        await db.execute({ sql: "update artists set image_url = ? where id = ?" });
      }`,
    );

    expect(sites.map((site) => [site.table, site.coupling])).toEqual([
      ["artists", "source-helper"],
      ["artists", null],
    ]);
    expect(sites.map((site) => site.projectionCoupling)).toEqual(["source-helper", null]);
  });

  it("discovers every eligibility satellite table as its own mutation site", () => {
    const satellites = [
      "artist_socials",
      "artist_aliases",
      "artist_centroids",
      "label_aliases",
      "track_embeddings",
      "track_duplicate_keys",
    ] as const;
    const sites = auditDueWorkMutationSites(
      "satellites.ts",
      satellites
        .map((table) => `db.execute({ sql: "delete from ${table} where id = ?" });`)
        .join("\n"),
    );

    expect(sites.map((site) => site.table)).toEqual([...satellites]);
    expect(DUE_WORK_ELIGIBILITY_TABLES).toEqual(expect.arrayContaining([...satellites]));
  });

  it("requires the repair marker in the mutation's own write batch or transaction", () => {
    const sites = auditDueWorkMutationSites(
      "split-batches.ts",
      `async function write(db: Db) {
        await db.batch([
          { sql: "update tracks set title = ? where track_id = ?" },
        ], "write");
        await db.batch([
          markDueWorkSourceRepairsStatement(subjects, { producer: "catalogue-rank" }),
        ], "write");
      }`,
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]?.coupling).toBeNull();
    expect(sites[0]?.projectionCoupling).toBeNull();
  });

  it("rejects crawl and rule markers split from their Goal D source transaction", () => {
    const sites = auditGoalDMutationSites(
      "split-goal-d.ts",
      `async function write(db: Db) {
        await db.batch([{ sql: "update crawl_frontier set state = 'done' where id = ?" }], "write");
        await db.batch([markCrawlNodeRepairStatement("node", "v1")], "write");
        await db.execute({ sql: "delete from artist_rules where id = ?" });
      }`,
    );

    expect(sites.map((site) => [site.table, site.projectionCoupling])).toEqual([
      ["crawl_frontier", null],
      ["artist_rules", null],
    ]);
  });

  it("accepts a marker in the same batch and in the same explicit write transaction", () => {
    const sites = auditDueWorkMutationSites(
      "coupled.ts",
      `async function batched(db: Db) {
        await db.batch([
          { sql: "update findings set note = ? where track_id = ?" },
          markDueWorkSourceRepairsStatement(subjects, { producer: "track-note-fill" }),
        ], "write");
      }
      async function transactional(db: Db) {
        const transaction = await db.transaction("write");
        await transaction.execute({ sql: "insert into track_artists values (?, ?)" });
        await transaction.batch([
          markDueWorkSourceRepairsStatement(subjects, { producer: "artist-edge-upsert" }),
        ]);
        await transaction.commit();
      }`,
    );

    expect(sites.map((site) => site.coupling)).toEqual(["write-batch", "write-transaction"]);
    expect(sites.map((site) => site.projectionCoupling)).toEqual([null, null]);
  });

  it("requires Goal D maintenance beside every inventoried source-table producer", async () => {
    const productionFiles = await productionSources();
    const sites = (
      await Promise.all(
        productionFiles.map(async ({ file, path }) =>
          auditDueWorkMutationSites(file, await readFile(path, "utf8")),
        ),
      )
    ).flat();
    const projectionTables = new Set(["findings", "labels", "track_artists", "tracks"]);

    expect(
      sites.filter(
        (site) =>
          projectionTables.has(site.table) &&
          site.coupling !== null &&
          site.projectionCoupling === null,
      ),
    ).toEqual([]);
  });

  it("inventories every Goal D source writer beside atomic projection maintenance", async () => {
    const productionFiles = await productionSources();
    const sites = (
      await Promise.all(
        productionFiles.map(async ({ file, path }) =>
          auditGoalDMutationSites(file, await readFile(path, "utf8")),
        ),
      )
    ).flat();

    const reviewed = new Set<string>();
    for (const entry of GOAL_D_REVIEWED_NONPROJECTION_WRITERS) {
      expect(entry.rationale.trim()).not.toBe("");
      expect(entry.sites.length).toBeGreaterThan(0);
      for (const site of entry.sites) {
        expect(site.startsWith(`${entry.file}:`)).toBe(true);
        expect(reviewed.has(site)).toBe(false);
        reviewed.add(site);
      }
    }

    expect(
      sites
        .filter((site) => site.projectionCoupling === null && !reviewed.has(site.id))
        .map((site) => site.id),
    ).toEqual([]);
    expect(
      [...reviewed].filter((site) => !sites.some((candidate) => candidate.id === site)),
    ).toEqual([]);
  });

  it("keeps every inventoried producer registered on an atomic maintenance callsite", async () => {
    const expected = DUE_WORK_PRODUCER_INVENTORY.flatMap((entry) =>
      entry.producers.map((producer) => `${entry.file}:${producer}`),
    ).sort();
    const productionFiles = await productionSources();
    const calls = (
      await Promise.all(
        productionFiles.map(async ({ file, path }) =>
          maintenanceCalls(file, await readFile(path, "utf8")),
        ),
      )
    ).flat();
    const actual = [...new Set(calls.map((call) => `${call.file}:${call.producer}`))].sort();

    expect(actual).toEqual(expected);
  });

  it("uses unique producer ids and declares at least one repaired subject kind per module", () => {
    const producers = DUE_WORK_PRODUCER_INVENTORY.flatMap((entry) => entry.producers);
    expect(new Set(producers).size).toBe(producers.length);
    expect(DUE_WORK_PRODUCER_INVENTORY.every((entry) => entry.subjects.length > 0)).toBe(true);
  });

  it("forces every eligibility-table mutation site into its own atomic or reviewed disposition", async () => {
    const productionFiles = await productionSources();
    const sources = await Promise.all(
      productionFiles.map(async ({ file, path }) => ({
        file,
        sourceText: await readFile(path, "utf8"),
      })),
    );
    const sites = sources.flatMap(({ file, sourceText }) =>
      auditDueWorkMutationSites(file, sourceText),
    );
    const inventoriedFiles = new Set<string>(
      DUE_WORK_PRODUCER_INVENTORY.map((entry) => entry.file),
    );
    const reviewedSites = new Set<string>();
    for (const entry of DUE_WORK_REVIEWED_NONPRODUCER_WRITERS) {
      expect(entry.sites.length).toBeGreaterThan(0);
      for (const site of entry.sites) {
        expect(reviewedSites.has(site)).toBe(false);
        expect(site.startsWith(`${entry.file}:`)).toBe(true);
        reviewedSites.add(site);
      }
      expect(entry.rationale.trim()).not.toBe("");

      if (entry.disposition === "delegated-atomicity") {
        const delegateNames = new Set<string>(entry.delegates);
        const calls = sources.flatMap(({ file, sourceText }) =>
          auditDueWorkDelegatedCallSites(file, sourceText, delegateNames),
        );
        expect(new Set(calls.map((call) => call.name))).toEqual(delegateNames);
        const callsByName = new Map(
          [...delegateNames].map((name) => [name, calls.filter((call) => call.name === name)]),
        );
        function safelyDelegated(name: string, visiting: ReadonlySet<string>): boolean {
          if (visiting.has(name)) {
            return false;
          }
          const nextVisiting = new Set(visiting).add(name);
          const namedCalls = callsByName.get(name) ?? [];
          return (
            namedCalls.length > 0 &&
            namedCalls.every(
              (call) =>
                call.coupling !== null ||
                (call.owner !== null &&
                  delegateNames.has(call.owner) &&
                  safelyDelegated(call.owner, nextVisiting)),
            )
          );
        }
        expect([...delegateNames].filter((name) => !safelyDelegated(name, new Set()))).toEqual([]);
      }
    }

    expect(
      sites.filter((site) => site.coupling !== null && !inventoriedFiles.has(site.file)),
    ).toEqual([]);
    expect(sites.filter((site) => site.coupling === null && !reviewedSites.has(site.id))).toEqual(
      [],
    );
    expect(
      [...reviewedSites].filter((site) => !sites.some((candidate) => candidate.id === site)),
    ).toEqual([]);
    const discoveredTables = new Set(sites.map((site) => site.table));
    for (const table of DUE_WORK_ELIGIBILITY_TABLES) {
      expect(discoveredTables.has(table), table).toBe(true);
    }
  });
});
