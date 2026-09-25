#!/usr/bin/env bun

import { createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";

import { ensureSearchIndex } from "../src/db/search-index";
import { ALBUMS_HUB_QUERY } from "../src/lib/server/albums";
import { ARTISTS_HUB_QUERY } from "../src/lib/server/artists";
import { hubPageAnchorsFromRows } from "../src/lib/server/hub-page-anchors";
import {
  CATALOGUE_HUB_DEFAULT_LIMIT,
  CATALOGUE_BROWSE_PAGE_SIZE,
  LABELS_HUB_QUERY,
  catalogueEntityAnchorExtractionQuery,
  catalogueEntityOffsetPageQuery,
  catalogueEntitySeekPageQuery,
} from "../src/lib/server/labels";
import {
  TRACKS_HUB_PAGE_SIZE,
  tracksHubAnchorExtractionQuery,
  tracksHubCountQuery,
  tracksHubHydrateQuery,
  tracksHubIdPageQuery,
  tracksHubSeekIdPageQuery,
  tracksHubYearLaneQuery,
} from "../src/lib/server/tracks-hub";

const BUDGET_MS = 800;
const ANCHOR_BUILD_BUDGET_MS = 2_500;

const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].flatMap((pitch) => [
  `${pitch} major`,
  `${pitch} minor`,
]);
const LABELS = ["Hospital Records", "Shogun Audio", "Critical Music", "Metalheadz", "V Recordings"];

function fail(message: string): never {
  console.error(`bench-tracks-hub: ${message}`);
  process.exit(1);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  return raw ? Number.parseInt(raw, 10) : fallback;
}

const url = process.env.SCRATCH_TURSO_DATABASE_URL;
const authToken = process.env.SCRATCH_TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  fail("set SCRATCH_TURSO_DATABASE_URL and SCRATCH_TURSO_AUTH_TOKEN (a THROWAWAY hosted DB)");
}

if (/fluncle(-dev)?\b/.test(url) || url.includes("127.0.0.1") || url.startsWith("file:")) {
  fail(`refusing to run against ${url} — use a SCRATCH hosted Turso DB, never prod/dev/local`);
}

const catalogueCount = envInt("BENCH_CATALOGUE", 25_000);
const findingsCount = envInt("BENCH_FINDINGS", 2_000);
const entityCount = envInt("BENCH_ENTITIES", 25_000);
const iterations = envInt("BENCH_ITERATIONS", 12);
const seekVsOffset = process.argv.includes("--seek-vs-offset");

const client = createClient({ authToken, concurrency: REMOTE_DB_CONCURRENCY, url });
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

function releaseDateForIndex(index: number): string {
  const end = Date.UTC(2026, 11, 31);
  const day = Math.floor(index / 3);
  const date = new Date(end - day * 24 * 60 * 60 * 1000);

  return date.toISOString().slice(0, 10);
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return sorted[index] ?? 0;
}

async function timeIt(run: () => Promise<unknown>): Promise<number> {
  const start = performance.now();

  await run();

  return performance.now() - start;
}

async function seedCatalogue(count: number): Promise<void> {
  const chunk = 500;

  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `cat-${index}`;

      const bpm = index % 11 === 0 ? null : 160 + (index % 40);

      statements.push({
        args: [
          trackId,
          `Catalogue ${index}`,
          `["Artist ${index % 800}"]`,
          releaseDateForIndex(index),
          `spotify:track:${trackId}`,
          `https://open.spotify.com/track/${trackId}`,
          bpm,
          KEYS[index % KEYS.length] ?? null,
          LABELS[index % LABELS.length] ?? null,
        ],
        sql: `insert or ignore into tracks
          (track_id, title, artists_json, release_date, spotify_uri, spotify_url, duration_ms, bpm, key, label)
          values (?, ?, ?, ?, ?, ?, 210000, ?, ?, ?)`,
      });
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  catalogue ${end}/${count}`);
  }

  process.stdout.write("\n");
}

async function seedFindings(count: number): Promise<void> {
  const chunk = 500;

  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const trackId = `find-${index}`;

      statements.push(
        {
          args: [
            trackId,
            `Finding ${index}`,
            `["Finding Artist ${index % 400}"]`,
            releaseDateForIndex(index),
            `spotify:track:${trackId}`,
            `https://open.spotify.com/track/${trackId}`,
            160 + (index % 40),
            KEYS[index % KEYS.length] ?? null,
            LABELS[index % LABELS.length] ?? null,
          ],
          sql: `insert or ignore into tracks
            (track_id, title, artists_json, release_date, spotify_uri, spotify_url, duration_ms, bpm, key, label)
            values (?, ?, ?, ?, ?, ?, 210000, ?, ?, ?)`,
        },
        {
          args: [
            trackId,
            `${String(index % 1000).padStart(3, "0")}.7.1A`,
            new Date().toISOString(),
          ],
          sql: `insert or ignore into findings (track_id, log_id, added_at) values (?, ?, ?)`,
        },
      );
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  findings ${end}/${count}`);
  }

  process.stdout.write("\n");
}

async function seedEntities(count: number): Promise<void> {
  const chunk = 300;

  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(count, start + chunk);
    const statements = [];

    for (let index = start; index < end; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const now = "2026-01-01T00:00:00.000Z";

      statements.push(
        {
          args: [`label-${suffix}`, `Label ${suffix}`, `label-${suffix}`, now, now],
          sql: `insert or ignore into labels
                (id, name, slug, created_at, updated_at, renderable_track_count)
                values (?, ?, ?, ?, ?, 3)`,
        },
        {
          args: [`album-${suffix}`, `Album ${suffix}`, `album-${suffix}`, now, now],
          sql: `insert or ignore into albums
                (id, name, slug, created_at, updated_at, renderable_track_count)
                values (?, ?, ?, ?, ?, 3)`,
        },
        {
          args: [`artist-${suffix}`, `Artist ${suffix}`, `artist-${suffix}`, now, now],
          sql: `insert or ignore into artists
                (id, name, slug, created_at, updated_at, renderable_track_count)
                values (?, ?, ?, ?, ?, 3)`,
        },
      );
    }

    await client.batch(statements, "write");
    process.stdout.write(`\r  entities ${end}/${count}`);
  }

  process.stdout.write("\n");
}

function cell(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

async function explain(sql: string, args: (number | string)[]): Promise<string> {
  const result = await client.execute({ args, sql: `explain query plan ${sql}` });

  return result.rows.map((row) => cell(row.detail)).join("\n      ");
}

type BenchShape = {
  args: (number | string)[];

  budgetMs?: number;

  gate?: boolean;
  name: string;
  sql: string;
};

async function main(): Promise<void> {
  console.log("bench-tracks-hub — applying migrations to the scratch DB…");
  await migrate(drizzle(client), { migrationsFolder });
  await ensureSearchIndex(client);

  console.log(`Seeding ${catalogueCount} catalogue rows…`);
  await seedCatalogue(catalogueCount);
  console.log(`Seeding ${findingsCount} findings…`);
  await seedFindings(findingsCount);

  if (seekVsOffset) {
    console.log(`Seeding ${entityCount} rows into each entity hub…`);
    await seedEntities(entityCount);
  }

  const limit = TRACKS_HUB_PAGE_SIZE;
  const deepOffset = Math.floor((catalogueCount * 0.8) / limit) * limit;

  const hydrateIds = Array.from({ length: limit }, (_, index) => `cat-${index}`);

  const yearLane = tracksHubYearLaneQuery({});

  const shapes: BenchShape[] = [
    { name: "id page 1 (unfiltered)", ...tracksHubIdPageQuery({}, limit, 0) },
    {
      gate: !seekVsOffset,
      name: `id page @ offset ${deepOffset}`,
      ...tracksHubIdPageQuery({}, limit, deepOffset),
    },
    { name: "hydrate 48 ids", ...tracksHubHydrateQuery(hydrateIds) },
    { name: "count(*) (unfiltered)", ...tracksHubCountQuery({}) },

    { args: yearLane.args, name: "year lane (unfiltered)", sql: yearLane.sql },
    {
      name: "id page (BPM 172–176)",
      ...tracksHubIdPageQuery({ bpmMax: 176, bpmMin: 172 }, limit, 0),
    },
    { name: "id page (key F minor)", ...tracksHubIdPageQuery({ key: "F minor" }, limit, 0) },
    {
      name: "id page (year 2018–2020)",
      ...tracksHubIdPageQuery({ yearMax: 2020, yearMin: 2018 }, limit, 0),
    },
    {
      name: "id page (BPM + year + label)",
      ...tracksHubIdPageQuery(
        { bpmMax: 180, bpmMin: 170, label: "Hospital Records", yearMax: 2026, yearMin: 2015 },
        limit,
        0,
      ),
    },
  ];

  if (seekVsOffset) {
    const deepPage = deepOffset / limit + 1;
    const unfilteredExtraction = tracksHubAnchorExtractionQuery({});
    const unfilteredAnchorResult = await client.execute(unfilteredExtraction);
    const unfilteredAnchors = hubPageAnchorsFromRows(
      unfilteredAnchorResult.rows as unknown as Record<string, unknown>[],
      "rd",
      limit,
    );
    const filtered = { bpmMax: 180, bpmMin: 170 };
    const filteredCountResult = await client.execute(tracksHubCountQuery(filtered));
    const filteredTotal = Number(filteredCountResult.rows[0]?.total ?? 0);
    const filteredOffset = Math.floor((filteredTotal * 0.8) / limit) * limit;
    const filteredPage = filteredOffset / limit + 1;
    const filteredExtraction = tracksHubAnchorExtractionQuery(filtered);
    const filteredAnchorResult = await client.execute(filteredExtraction);
    const filteredAnchors = hubPageAnchorsFromRows(
      filteredAnchorResult.rows as unknown as Record<string, unknown>[],
      "rd",
      limit,
    );

    shapes.push(
      {
        budgetMs: ANCHOR_BUILD_BUDGET_MS,
        name: "anchors (tracks unfiltered)",
        ...unfilteredExtraction,
      },
      {
        name: `seek tracks page ${deepPage}`,
        ...tracksHubSeekIdPageQuery({}, deepPage, unfilteredAnchors),
      },
      {
        gate: false,
        name: `offset tracks filtered @ ${filteredOffset}`,
        ...tracksHubIdPageQuery(filtered, limit, filteredOffset),
      },
      {
        budgetMs: ANCHOR_BUILD_BUDGET_MS,
        name: "anchors (tracks filtered)",
        ...filteredExtraction,
      },
      {
        name: `seek tracks filtered page ${filteredPage}`,
        ...tracksHubSeekIdPageQuery(filtered, filteredPage, filteredAnchors),
      },
    );

    const entityQueries = [
      { name: "labels", query: LABELS_HUB_QUERY },
      { name: "albums", query: ALBUMS_HUB_QUERY },
      { name: "artists", query: ARTISTS_HUB_QUERY },
    ];
    const entitySurfaces = [
      { name: "hub", pageSize: CATALOGUE_HUB_DEFAULT_LIMIT },
      { name: "browse", pageSize: CATALOGUE_BROWSE_PAGE_SIZE },
    ];

    for (const entity of entityQueries) {
      for (const surface of entitySurfaces) {
        const pageSize = surface.pageSize;
        const offset = Math.floor((entityCount * 0.8) / pageSize) * pageSize;
        const page = offset / pageSize + 1;
        const extraction = catalogueEntityAnchorExtractionQuery(entity.query, pageSize);
        const anchorResult = await client.execute(extraction);
        const anchors = hubPageAnchorsFromRows(
          anchorResult.rows as unknown as Record<string, unknown>[],
          "slug",
          pageSize,
        );

        shapes.push(
          {
            gate: false,
            name: `offset ${entity.name} ${surface.name} @ ${offset}`,
            ...catalogueEntityOffsetPageQuery(entity.query, pageSize, offset),
          },
          {
            budgetMs: ANCHOR_BUILD_BUDGET_MS,
            name: `anchors (${entity.name} ${surface.name})`,
            ...extraction,
          },
          {
            name: `seek ${entity.name} ${surface.name} page ${page}`,
            ...catalogueEntitySeekPageQuery(entity.query, pageSize, page, anchors),
          },
        );
      }
    }
  }

  let allWithinBudget = true;

  console.log("\n── p50 per shape ────────────────────────────────────────────────");
  for (const shape of shapes) {
    const samples: number[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      samples.push(await timeIt(() => client.execute({ args: shape.args, sql: shape.sql })));
    }

    const p50 = percentile(samples, 50);
    const budgetMs = shape.budgetMs ?? BUDGET_MS;
    const within = p50 < budgetMs;
    allWithinBudget &&= shape.gate === false || within;

    console.log(
      `  ${shape.name.padEnd(30)} p50 ${p50.toFixed(1).padStart(7)} ms  ${
        within ? "✓ under" : "✗ OVER"
      } ${budgetMs} ms${shape.gate === false ? " (comparison only)" : ""}`,
    );
  }

  console.log("\n── EXPLAIN QUERY PLAN ───────────────────────────────────────────");
  for (const shape of shapes) {
    const plan = await explain(shape.sql, shape.args);
    console.log(`  ${shape.name}:\n      ${plan}`);
    const isEntityShape = /\b(?:labels|albums|artists)\b/.test(shape.name);

    if (isEntityShape) {
      console.log("  → entity gated-CTE plan captured; inspect the hosted seek before merge.\n");
      continue;
    }

    const ridesReleaseIndex = /tracks_release_date_track_id_idx/.test(plan);
    const fullScan = /SCAN tracks\b(?! USING)/.test(plan);
    console.log(
      `  → ${ridesReleaseIndex ? "rides tracks_release_date_track_id_idx" : "NOT on the release-date index"}${
        fullScan ? " — WARNING: a full SCAN tracks appears" : ""
      }\n`,
    );
  }

  console.log(
    allWithinBudget
      ? "SHIP GATE: PASS — every hub shape's p50 under budget."
      : "SHIP GATE: FAIL — a shape blew the 800 ms budget. Do NOT merge on these numbers.",
  );
  process.exit(allWithinBudget ? 0 : 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
