#!/usr/bin/env bun
/**
 * Capture the frozen context-distil fuel corpus. This script reads track metadata,
 * calls only Firecrawl Search and the Apple catalogue editorial leg, then writes the
 * raw snippets and sources. It never calls OpenRouter, resolves a prompt, writes a
 * database row, or imports the cost ledger.
 *
 * The output is rewritten after every captured track, so re-running resumes from the
 * first trackId not already present in distil-corpus.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appleCatalogLookupByIsrc } from "../src/lib/server/apple-music";
import { getDb, typedRow } from "../src/lib/server/db";
import { loadLocalEnv, readOptionalEnv } from "../src/lib/server/env";
import {
  APPLE_EDITORIAL_SNIPPET_LABEL,
  buildContextQuery,
  extractAppleEditorialFuel,
  extractFirecrawlContextFuel,
  FIRECRAWL_SEARCH_URL,
} from "../src/lib/server/observation";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(SCRIPT_DIR, "fixtures");
const TRACKS_PATH = join(FIXTURE_DIR, "distil-corpus-tracks.json");
const CORPUS_PATH = join(FIXTURE_DIR, "distil-corpus.json");

type TrackFixture = { note: string; trackId: string };
type CorpusEntry = {
  capturedAt: string;
  query: string;
  snippets: string[];
  sources: string[];
  trackId: string;
};
type TrackRow = {
  artists_json: string;
  isrc: string | null;
  label: string | null;
  title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTrackFixture(value: unknown): value is TrackFixture {
  return isRecord(value) && typeof value.trackId === "string" && typeof value.note === "string";
}

function isCorpusEntry(value: unknown): value is CorpusEntry {
  return (
    isRecord(value) &&
    typeof value.capturedAt === "string" &&
    typeof value.query === "string" &&
    isStringArray(value.snippets) &&
    isStringArray(value.sources) &&
    typeof value.trackId === "string"
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseArtists(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;

    return isStringArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function fetchFuel(
  query: string,
  isrc: string | null,
  firecrawlKey: string,
): Promise<{ appleCount: number; snippets: string[]; sources: string[] }> {
  const response = await fetch(FIRECRAWL_SEARCH_URL, {
    body: JSON.stringify({ limit: 5, query }),
    headers: {
      Authorization: `Bearer ${firecrawlKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Firecrawl HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  let payload: unknown;

  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`Firecrawl returned non-JSON HTTP ${response.status}`);
  }

  const fuel = extractFirecrawlContextFuel(payload);

  if (!isrc?.trim()) {
    return { appleCount: 0, ...fuel };
  }

  const apple = await appleCatalogLookupByIsrc(isrc);

  if (!apple.configured || !apple.ok || !apple.bundle) {
    return { appleCount: 0, ...fuel };
  }

  const appleFuel = extractAppleEditorialFuel(apple.bundle);

  for (const text of appleFuel.texts) {
    fuel.snippets.push(`${APPLE_EDITORIAL_SNIPPET_LABEL}: ${text}`);
  }

  if (appleFuel.sourceUrl) {
    fuel.sources.push(appleFuel.sourceUrl);
  }

  return { appleCount: appleFuel.texts.length, ...fuel };
}

async function main(): Promise<void> {
  let trackValue: unknown;
  let corpusValue: unknown;

  try {
    [trackValue, corpusValue] = await Promise.all([readJson(TRACKS_PATH), readJson(CORPUS_PATH)]);
  } catch (error) {
    console.error(
      `capture-distil-corpus: fixture read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(trackValue) || !trackValue.every(isTrackFixture)) {
    console.error(
      "capture-distil-corpus: distil-corpus-tracks.json must be an array of { trackId, note } objects.",
    );
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(corpusValue) || !corpusValue.every(isCorpusEntry)) {
    console.error(
      "capture-distil-corpus: distil-corpus.json must be an array of captured corpus entries.",
    );
    process.exitCode = 1;
    return;
  }

  if (trackValue.length === 0 || trackValue.some((track) => track.trackId === "...")) {
    console.log(
      "capture-distil-corpus: track fixture is still a placeholder; replace it with real trackIds. Nothing called.",
    );
    return;
  }

  // Bun scripts do not set Vite's import.meta.env.DEV flag. Force the same loader the
  // app uses so apps/web/.dev.vars remains the single local-env path.
  await loadLocalEnv({ force: true });

  const firecrawlKey = await readOptionalEnv("FIRECRAWL_API_KEY");
  const databaseUrl = await readOptionalEnv("TURSO_DATABASE_URL");
  const databaseToken = await readOptionalEnv("TURSO_AUTH_TOKEN");
  const missing = [
    !firecrawlKey ? "FIRECRAWL_API_KEY" : undefined,
    !databaseUrl ? "TURSO_DATABASE_URL" : undefined,
    !databaseToken ? "TURSO_AUTH_TOKEN" : undefined,
  ].filter((name): name is string => typeof name === "string");

  if (missing.length > 0 || !firecrawlKey) {
    console.log(
      `capture-distil-corpus: missing ${missing.join(", ")}; capture skipped. Nothing called.`,
    );
    return;
  }

  const db = await getDb();
  const corpus = [...corpusValue];
  const capturedIds = new Set(corpus.map((entry) => entry.trackId));
  let captured = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, fixture] of trackValue.entries()) {
    if (capturedIds.has(fixture.trackId)) {
      skipped += 1;
      console.log(`${index + 1}/${trackValue.length} ${fixture.trackId} SKIP already captured`);
      continue;
    }

    const row = typedRow<TrackRow>(
      (
        await db.execute({
          args: [fixture.trackId],
          sql: `select title, artists_json, label, isrc
                  from tracks
                 where track_id = ?
                 limit 1`,
        })
      ).rows,
    );

    if (!row) {
      failed += 1;
      console.log(`${index + 1}/${trackValue.length} ${fixture.trackId} FAIL track not found`);
      continue;
    }

    const query = buildContextQuery({
      artists: parseArtists(row.artists_json),
      label: row.label ?? undefined,
      title: row.title,
    });

    try {
      const fuel = await fetchFuel(query, row.isrc, firecrawlKey);
      const entry: CorpusEntry = {
        capturedAt: new Date().toISOString(),
        query,
        snippets: fuel.snippets,
        sources: fuel.sources,
        trackId: fixture.trackId,
      };

      corpus.push(entry);
      capturedIds.add(entry.trackId);
      await writeFile(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
      captured += 1;
      console.log(
        `${index + 1}/${trackValue.length} ${fixture.trackId} OK snippets=${fuel.snippets.length} apple=${fuel.appleCount} sources=${fuel.sources.length}`,
      );
    } catch (error) {
      failed += 1;
      console.log(
        `${index + 1}/${trackValue.length} ${fixture.trackId} FAIL ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `capture-distil-corpus: captured=${captured} skipped=${skipped} failed=${failed} total=${corpus.length}`,
  );
}

await main();
