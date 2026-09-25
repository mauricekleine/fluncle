import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkTrackToAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { createIntegrationDb } from "./integration-db";
import { linkTrackToLabel } from "./labels";
import { searchArchive as searchArchiveLive } from "./search";
import { EMBEDDING_DIMS } from "./embedding";
import { SEARCH_EXAMPLES, type SearchExampleIcon } from "@/lib/search-results";

const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => db };
});

function searchArchive(options: { limit?: number; q: string }) {
  return searchArchiveLive({ ...options, allowBoundedSonicForDiagnostics: true });
}

function angleVector(angle: number): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMS);

  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);

  return vector;
}

type Fixture = {
  album?: string;
  angle?: number;
  artists: string[];
  label?: string;
  logId: string;
  title: string;
  trackId: string;
};

async function seed(client: Client, track: Fixture): Promise<void> {
  const embedding = track.angle === undefined ? null : angleVector(track.angle);

  await client.execute({
    args: [
      track.trackId,
      track.title,
      JSON.stringify(track.artists),
      track.album ?? null,
      track.label ?? null,
      `https://open.spotify.com/track/${track.trackId}`,
      180_000,
      embedding ? 1 : 0,
    ],
    sql: `insert into tracks
      (track_id, title, artists_json, album, label, spotify_url, duration_ms, has_embedding)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  if (embedding) {
    await client.execute({
      args: [track.trackId, new Uint8Array(embedding.buffer)],
      sql: `insert into track_embeddings (track_id, embedding_blob) values (?, ?)`,
    });
  }

  await client.execute({
    args: [track.trackId, track.logId, "2026-07-01T00:00:00.000Z"],
    sql: `insert into findings (track_id, log_id, added_at) values (?, ?, ?)`,
  });
  await client.execute({
    args: [track.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });

  await linkTrackToLabel(track.trackId, track.label);
  await linkTrackToAlbum(track.trackId, track.album);
  await linkTracksToArtistEntities([track.trackId]);
}

const FIXTURES: Record<string, Fixture[]> = {
  "004.7.2I": [
    {
      album: "Nobody Else (1991 Remix)",
      artists: ["1991"],
      label: "Axtone Records",
      logId: "004.7.2I",
      title: "Nobody Else",
      trackId: "example-coordinate",
    },
  ],
  "Hospital Records": [
    {
      album: "Second Nature",
      artists: ["Netsky"],
      label: "Hospital Records",
      logId: "012.4.4D",
      title: "Let's Leave Tomorrow",
      trackId: "example-label",
    },
  ],
  netsky: [
    {
      album: "Second Nature",
      artists: ["Netsky"],
      label: "Hospital Records",
      logId: "012.4.4D",
      title: "Let's Leave Tomorrow",
      trackId: "example-label",
    },
  ],
  "tracks that sound like Nine Clouds": [
    {
      album: "Chapter One",
      angle: 0,
      artists: ["1991"],
      label: "1991",
      logId: "024.7.2R",
      title: "Nine Clouds",
      trackId: "example-anchor",
    },
    {
      album: "Second Nature",
      angle: 0.1,
      artists: ["Netsky"],
      label: "Hospital Records",
      logId: "012.4.4D",
      title: "Let's Leave Tomorrow",
      trackId: "example-neighbour",
    },
  ],
};

const DETERMINISTIC_KINDS: Record<SearchExampleIcon, readonly string[]> = {
  coordinate: ["coordinate"],
  sonic: ["sonic"],
  token: ["entity", "token"],
};

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-search-examples-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  translateQuery.mockReset();
  translateQuery.mockResolvedValue(null);
});

afterEach(async () => {
  db.close();

  if (fixtureDirectory) {
    await rm(fixtureDirectory, { force: true, recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("every worked example resolves without a model", () => {
  it("has a fixture for every example on the list", () => {
    const unfixtured = SEARCH_EXAMPLES.map((example) => example.query).filter(
      (query) => FIXTURES[query] === undefined,
    );

    expect(
      unfixtured,
      `add a fixture to FIXTURES for: ${unfixtured.join(", ")}. An example query is shown to readers as one that WORKS, so it has to be proven here before it ships.`,
    ).toEqual([]);
  });

  for (const example of SEARCH_EXAMPLES) {
    it(`answers “${example.query}” from a deterministic tier, with rows`, async () => {
      for (const fixture of FIXTURES[example.query] ?? []) {
        await seed(db, fixture);
      }

      const result = await searchArchive({ q: example.query });

      expect(result.degraded, `“${example.query}” fell through to the language tier`).toBe(false);
      expect(
        DETERMINISTIC_KINDS[example.icon],
        `“${example.query}” was answered by the ${result.kind} tier, not the ${example.icon} one`,
      ).toContain(result.kind);
      expect(
        result.results.length + result.entities.length,
        `“${example.query}” came back empty — an example that finds nothing teaches the opposite of what it is for`,
      ).toBeGreaterThan(0);
    });
  }

  it("never consults the model for any of them", async () => {
    for (const fixtures of Object.values(FIXTURES)) {
      for (const fixture of fixtures) {
        await seed(db, fixture).catch(() => undefined);
      }
    }

    translateQuery.mockClear();

    for (const example of SEARCH_EXAMPLES) {
      await searchArchive({ q: example.query });
    }

    expect(translateQuery).not.toHaveBeenCalled();
  });
});
