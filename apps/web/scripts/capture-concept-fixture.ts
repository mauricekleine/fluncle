#!/usr/bin/env bun
/**
 * Captures the real-data snapshot the held discovery concepts render from.
 *
 * The concepts are a comparison exhibit, not a shipped surface, so they read a
 * COMMITTED capture of Fluncle's own public API rather than the server query
 * primitives. Two reasons the capture is the honest source here: the sonic tier
 * ranks against MuQ embeddings that no public endpoint exposes (so a local
 * database could never answer "sounds like"), and a frozen snapshot makes every
 * screenshot in the evidence set reproducible from one command.
 *
 * Everything below is a public, unauthenticated, anonymous GET. Nothing is
 * written to production.
 *
 *   bun run --cwd apps/web concepts:capture
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = process.env.FLUNCLE_CONCEPT_SOURCE ?? "https://www.fluncle.com";
const OUT = join(import.meta.dir, "..", "src", "concepts", "discovery", "fixture");

/** Anchors chosen to span galaxies, tempos, and both a dense and a thin imprint. */
const SONIC_ANCHORS = [
  "090.6.2K",
  "086.5.9Q",
  "073.8.9G",
  "069.5.7G",
  "066.5.2K",
  "063.6.7Y",
  "061.5.0W",
  "061.4.2B",
];

/** The entity landings each concept has to prove a direct arrival on. */
const ENTITIES: { kind: "album" | "artist" | "label"; slug: string }[] = [
  { kind: "artist", slug: "lexurus" },
  { kind: "artist", slug: "melinki" },
  { kind: "artist", slug: "winslow" },
  { kind: "label", slug: "hospital-records" },
  { kind: "label", slug: "v-recordings" },
  { kind: "album", slug: "bob-weave" },
];

const CATALOGUE_PAGES = 3;

async function get(path: string): Promise<unknown> {
  const url = `${BASE}${path}`;
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "fluncle-concept-capture" },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status}`);
  }

  return response.json();
}

function search(q: string, limit = 24): Promise<unknown> {
  return get(`/api/v1/search/archive?q=${encodeURIComponent(q)}&limit=${limit}`);
}

/**
 * Drops the fields the concepts never read. Keeping the snapshot lean matters in
 * a public repo: this file is committed, and an unread field is weight with no
 * reader. The expiring Deezer `previewUrl` is deliberately among the drops —
 * every concept plays through `/api/preview/<logId>`, which mints a fresh one.
 */
function trimFinding(track: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "addedAt",
    "album",
    "albumImageUrl",
    "albumSlug",
    "appleMusicUrl",
    "artists",
    "bpm",
    "durationMs",
    "galaxy",
    "key",
    "label",
    "labelSlug",
    "logId",
    "logPageUrl",
    "note",
    "releaseDate",
    "spotifyUrl",
    "title",
    "trackId",
    "type",
    "youtubeUrl",
  ];

  return Object.fromEntries(keep.filter((k) => track[k] !== undefined).map((k) => [k, track[k]]));
}

async function captureFindings(): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  do {
    const query = cursor ? `?limit=48&cursor=${encodeURIComponent(cursor)}` : "?limit=48";
    const page = (await get(`/api/v1/findings${query}`)) as {
      nextCursor?: string;
      tracks: Record<string, unknown>[];
    };

    all.push(...page.tracks.map(trimFinding));
    cursor = page.nextCursor;
  } while (cursor);

  return all;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const health = (await get("/api/v1/health")) as { sha: string };
  const findings = await captureFindings();
  const fresh = await get("/api/v1/tracks/fresh?limit=100");

  const catalogue: Record<string, unknown>[] = [];
  for (let page = 1; page <= CATALOGUE_PAGES; page++) {
    const body = (await get(`/api/v1/tracks?page=${page}&certified=false`)) as {
      tracks: Record<string, unknown>[];
    };
    catalogue.push(...body.tracks);
  }

  const neighbours: Record<string, unknown> = {};
  for (const logId of SONIC_ANCHORS) {
    const finding = findings.find((f) => f.logId === logId);
    if (!finding) {
      throw new Error(`Sonic anchor ${logId} is not in the captured findings`);
    }

    neighbours[logId] = await search(`sounds like ${String(finding.title)}`, 16);
  }

  const entities: Record<string, unknown> = {};
  for (const entity of ENTITIES) {
    const dossier = await get(`/api/v1/${entity.kind}s/${entity.slug}`);
    const identity = (dossier as Record<string, Record<string, unknown>>)[entity.kind];
    const tracks = await search(String(identity.name), 24);

    entities[`${entity.kind}:${entity.slug}`] = { identity, kind: entity.kind, tracks };
  }

  const searches: Record<string, unknown> = {};
  for (const q of ["174 bpm rollers", "jungle", "Metalheadz", "A minor"]) {
    searches[q] = await search(q, 16);
  }

  const write = async (name: string, value: unknown): Promise<void> => {
    await writeFile(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  };

  await write("meta.json", {
    capturedAt: new Date().toISOString(),
    catalogueRows: catalogue.length,
    findingCount: findings.length,
    productionSha: health.sha,
    source: BASE,
    surfaces: [
      "/api/v1/findings",
      "/api/v1/tracks?certified=false",
      "/api/v1/tracks/fresh",
      "/api/v1/search/archive",
      "/api/v1/{artists,labels,albums}/{slug}",
    ],
  });
  await write("findings.json", findings);
  await write("fresh.json", fresh);
  await write("catalogue.json", catalogue);
  await write("neighbours.json", neighbours);
  await write("entities.json", entities);
  await write("searches.json", searches);

  console.log(
    `captured ${findings.length} findings, ${catalogue.length} catalogue rows, ` +
      `${Object.keys(neighbours).length} sonic anchors, ${Object.keys(entities).length} entities ` +
      `from ${BASE} at ${health.sha}`,
  );
}

await main();
