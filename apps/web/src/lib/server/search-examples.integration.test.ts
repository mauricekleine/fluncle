import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkTrackToAlbum } from "./albums";
import { linkTracksToArtistEntities } from "./artists";
import { createIntegrationDb } from "./integration-db";
import { linkTrackToLabel } from "./labels";
import { searchArchive } from "./search";
import { EMBEDDING_DIMS } from "./embedding";
import { SEARCH_EXAMPLES, type SearchExampleIcon } from "@/lib/search-results";

// THE WORKED EXAMPLES ARE A PROMISE, AND THIS IS THE HALF OF IT THAT RUNS OFFLINE.
//
// `SEARCH_EXAMPLES` (lib/search-results.ts) is shown in three places — the ⌘K palette's empty
// state, the front door's band, and `/search`'s zero state — and every one of them says, in
// effect, "these work". An example query that finds nothing teaches the opposite of what it is
// for, so the list carries a contract: each query is REAL, and each is answered WITHOUT a model.
//
// ── WHY "WITHOUT A MODEL" IS THE LOAD-BEARING HALF ──────────────────────────────────────────
// The fourth tier is nondeterministic by construction. The list used to carry a natural-language
// filter query to teach it, and the same sentence parsed once to `{bpmMin, key}` (rows) and once
// to `{bpmMin, key, text: "tracks"}` — where the stray leftover word narrowed the answer to
// nothing. A worked example that is a coin flip is not a worked example. So the contract is not
// "usually returns something"; it is "resolved by a tier that cannot vary", and that is a thing a
// test can actually hold.
//
// `translateQuery` is stubbed to `null` here — the model OFF, which is exactly what the resolver
// sees when OPENROUTER_API_KEY is unset. Any example that needed tier 4 would come back
// `degraded: true` with whatever full-text scraps the fallback found, and this file fails it.
//
// It runs against a REAL migrated database rather than a mock, because three of the four tiers
// under test ARE SQL: the indexed coordinate seek, the entity read through the maintained hub
// counts, and the `vector_distance_cos` scan behind its `track_embeddings` join.
//
// ── AND IT IS DRIVEN BY THE LIST, NOT BY A COPY OF IT ───────────────────────────────────────
// The cases below are generated from `SEARCH_EXAMPLES` itself, so a fifth example cannot be added
// without also giving it a fixture: an unfixtured query fails with a message saying so. The other
// half of the promise — that the query is non-empty against the LIVE archive, which no offline
// test can know — is held by `scripts/post-deploy-probe.ts` after every deploy.

const translateQuery = vi.hoisted(() => vi.fn<(q: string) => Promise<unknown>>());

vi.mock("./search-llm", () => ({ translateQuery }));

let db: Client;
let fixtureDirectory: string | undefined;

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => db };
});

/** A unit vector at `angle` radians in the (0,1) plane — cosine distance is then arithmetic. */
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

/** Seed one CERTIFIED finding through the real publish-path link functions. */
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
  // Keystone 1's maintained discriminator, set exactly as `publishTrack` does — the link calls
  // below read it to move each entity's `certified_finding_count`, which is half of the hub gate
  // that decides whether the entity tier may offer this label at all.
  await client.execute({
    args: [track.trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });

  await linkTrackToLabel(track.trackId, track.label);
  await linkTrackToAlbum(track.trackId, track.album);
  await linkTracksToArtistEntities([track.trackId]);
}

/**
 * The fixture each example needs in order to resolve, keyed BY THE QUERY ITSELF.
 *
 * Keying on the query is what makes this file a gate rather than a parallel list: the cases are
 * generated from `SEARCH_EXAMPLES`, so an example with no entry here has nowhere to hide.
 */
const FIXTURES: Record<string, Fixture[]> = {
  // Tier 1 — the coordinate. One indexed seek; it names exactly one finding.
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
  // Tier 2 — an exact label name, offered as a jump target once it clears the hub gate.
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
  // Tier 2/3 — one bare word: the artist as a jump target, their tracks under it.
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
  // Tier 3½ — the sonic phrase. It needs the anchor AND something else embedded to rank, since
  // the scan excludes the anchor itself; a lone embedded row would return an empty list.
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

/** The tiers each glyph is allowed to be answered by — every one of them deterministic. */
const DETERMINISTIC_KINDS: Record<SearchExampleIcon, readonly string[]> = {
  // A name resolves as an ENTITY when the archive holds one by that exact name and as a TOKEN
  // otherwise; both are indexed reads in front of the model, so either is a pass.
  coordinate: ["coordinate"],
  sonic: ["sonic"],
  token: ["entity", "token"],
};

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "fluncle-search-examples-"));
  db = await createIntegrationDb({ url: `file:${join(fixtureDirectory, "fixture.db")}` });
  translateQuery.mockReset();
  // THE MODEL IS OFF. Every assertion below is about what answers WITHOUT it.
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

      // THE CONTRACT, in three assertions. Degraded means the model was reached for and could not
      // run — which is what a nondeterministic example looks like from here.
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

  // The rail stated directly, so the reason survives the next edit: the model is never consulted
  // for any of these, even when it is available.
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
