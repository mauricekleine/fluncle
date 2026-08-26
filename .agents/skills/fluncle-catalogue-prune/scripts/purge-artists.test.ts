import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { type Catalogue, tracksCreditedOnlyTo } from "./lib";
import { main, parseArtistsFile, planNamedArtistPurge } from "./purge-artists";

// The prune scripts talk to PRODUCTION and DELETE rows, so nothing here may touch a real database.
// These tests drive a recording stub of the libSQL `Client` and pin the four rails that decide
// whether the targeted namesake purge can do damage: the SHARED-CREDIT survival rule, the FINDINGS
// hard abort, the ENTANGLEMENT abort, and that a dry-run performs ZERO writes.

type Row = Record<string, unknown>;
type Statement = { args?: unknown; sql: string };

type Stub = {
  batches: { mode?: string; stmts: Statement[] }[];
  client: Client;
  executed: string[];
};

/** Every statement that could change the database. A dry-run must issue none of these. */
const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

// Redirect the rollback snapshot before ANY test runs. The script defaults `PRUNE_OUT_DIR` to `.`,
// so a confirm-path test without this writes a `*-rollback.json` into the repo — and in a real run
// that file is verbatim production rows. Set once, at the top, so a future test cannot forget.
const PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "prune-artists-"));
process.env.PRUNE_OUT_DIR = PRUNE_OUT_DIR;

afterAll(() => {
  rmSync(PRUNE_OUT_DIR, { force: true, recursive: true });
});

function stub(rowsFor: (sql: string) => Row[] = () => []): Stub {
  const batches: Stub["batches"] = [];
  const executed: string[] = [];
  const client = {
    batch: async (stmts: Statement[], mode?: string) => {
      batches.push({ mode, stmts });

      return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
    },
    execute: async (stmt: Statement | string) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      executed.push(sql);

      return { rows: rowsFor(sql), rowsAffected: 1 };
    },
  };

  return { batches, client: client as unknown as Client, executed };
}

type CatalogueSpec = {
  albums?: [string, string][];
  artists: { id: string; name: string; slug: string }[];
  db: Client;
  disabled?: string[];
  edges: { artist_id: string; track_id: string }[];
  enabled?: string[];
  findingTrackIds?: string[];
  tracks: { album_id: string | null; label: string | null; title: string; track_id: string }[];
};

/** A whole in-memory catalogue — the loader's return shape, built by hand instead of from prod. */
function catalogue(spec: CatalogueSpec): Catalogue {
  const artists = spec.artists.map((a) => ({ ...a, spotify_url: null }));
  const enabledSlugs = new Set(spec.enabled ?? []);
  const disabledSlugs = new Set(spec.disabled ?? []);
  const slug = (s: string | null) => (s ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

  return {
    albumName: new Map(spec.albums ?? []),
    artistById: new Map(artists.map((a) => [a.id, a])),
    artists,
    db: spec.db,
    disabledSlugs,
    edges: spec.edges,
    enabledSlugs,
    findingTrackIds: new Set(spec.findingTrackIds ?? []),
    labels: [...enabledSlugs]
      .map((s) => ({ id: s, name: s, seed_state: "enabled", slug: s }))
      .concat([...disabledSlugs].map((s) => ({ id: s, name: s, seed_state: "disabled", slug: s }))),
    trackById: new Map(spec.tracks.map((t) => [t.track_id, t])),
    trackDisabled: (t) => Boolean(t.label && disabledSlugs.has(slug(t.label))),
    trackEnabled: (t) => Boolean(t.label && enabledSlugs.has(slug(t.label))),
    tracks: spec.tracks,
  };
}

/** Run `main` with `console.log` captured, so the suite stays readable and the output assertable. */
async function run(argv: string[], cat: Catalogue): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(argv, async () => cat);

    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

/**
 * The namesake scenario, in miniature. `impostor` is the wrong same-named act the operator named;
 * `guest` is an artist nobody ruled on. `shared` is credited to both, so it must survive.
 */
const namesake = (db: Client, opts: { findingTrackIds?: string[] } = {}) =>
  catalogue({
    artists: [
      { id: "A_IMP", name: "Impostor Records Act", slug: "impostor" },
      { id: "A_GUEST", name: "Innocent Guest", slug: "guest" },
    ],
    db,
    edges: [
      { artist_id: "A_IMP", track_id: "t_solo1" },
      { artist_id: "A_IMP", track_id: "t_solo2" },
      { artist_id: "A_IMP", track_id: "t_shared" },
      { artist_id: "A_GUEST", track_id: "t_shared" },
      { artist_id: "A_GUEST", track_id: "t_guest" },
    ],
    enabled: ["radar-records"],
    findingTrackIds: opts.findingTrackIds,
    tracks: [
      { album_id: "al_solo", label: "Radar Records", title: "Solo One", track_id: "t_solo1" },
      { album_id: "al_solo", label: "Radar Records", title: "Solo Two", track_id: "t_solo2" },
      { album_id: "al_mixed", label: "Radar Records", title: "Split Bill", track_id: "t_shared" },
      { album_id: "al_mixed", label: "Radar Records", title: "Guest Only", track_id: "t_guest" },
    ],
  });

describe("the shared-credit survival rule", () => {
  test("a track credited ONLY to named artists is deletable", () => {
    const cat = namesake(stub().client);

    expect([...tracksCreditedOnlyTo(cat, new Set(["A_IMP"]))].sort()).toEqual([
      "t_solo1",
      "t_solo2",
    ]);
  });

  test("a track shared with an artist you did NOT name survives", () => {
    const cat = namesake(stub().client);

    expect(tracksCreditedOnlyTo(cat, new Set(["A_IMP"])).has("t_shared")).toBe(false);
  });

  test("naming BOTH credited artists makes the shared track deletable", () => {
    const cat = namesake(stub().client);

    expect(tracksCreditedOnlyTo(cat, new Set(["A_IMP", "A_GUEST"])).has("t_shared")).toBe(true);
  });

  test("a findings track is never deletable, even when the credit is exclusive", () => {
    const cat = namesake(stub().client, { findingTrackIds: ["t_solo1"] });

    expect([...tracksCreditedOnlyTo(cat, new Set(["A_IMP"]))]).toEqual(["t_solo2"]);
  });

  test("a track with no track_artists edge is out of reach of an artist-driven purge", () => {
    const cat = catalogue({
      artists: [{ id: "A", name: "A", slug: "a" }],
      db: stub().client,
      edges: [],
      tracks: [{ album_id: null, label: null, title: "Orphan", track_id: "t_lonely" }],
    });

    expect(tracksCreditedOnlyTo(cat, new Set(["A"])).size).toBe(0);
  });

  test("the plan reports the surviving track under the artist that keeps it", () => {
    const cat = namesake(stub().client);
    const plan = planNamedArtistPurge(cat, new Set(["A_IMP"]));

    expect(plan.trackIds.sort()).toEqual(["t_solo1", "t_solo2"]);
    expect(plan.survivors.get("A_IMP")).toEqual(["t_shared"]);
    // The album still holding a surviving track is NOT orphaned; the all-deleted one is.
    expect(plan.albumIds).toEqual(["al_solo"]);
  });

  test("the dry-run NAMES the surviving track and its other credit", async () => {
    const cat = namesake(stub().client);
    const { code, out } = await run(["--artists", "impostor"], cat);

    expect(code).toBe(0);
    expect(out).toContain("tracks that SURVIVE");
    expect(out).toContain("Split Bill");
    expect(out).toContain("Innocent Guest");
  });
});

describe("the findings hard abort", () => {
  test("a named artist carrying a findings track aborts the whole run", async () => {
    const s = stub();
    const cat = namesake(s.client, { findingTrackIds: ["t_solo1"] });
    const { code, out } = await run(["--artists", "impostor", "--confirm"], cat);

    expect(code).toBe(1);
    expect(out).toContain("FINDING");
    expect(out).toContain("ABORTED");
    // Hard abort, not a skip: the OTHER named artists are not purged either.
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("a finding on an artist you did NOT name does not block the run", async () => {
    const cat = namesake(stub().client, { findingTrackIds: ["t_guest"] });
    const { code } = await run(["--artists", "impostor"], cat);

    expect(code).toBe(0);
  });
});

describe("the unknown-slug hard abort", () => {
  test("a slug with no artists row aborts rather than silently purging the rest", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artists", "impostor|typo-slug", "--confirm"],
      namesake(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain("typo-slug");
    expect(out).toContain("ABORTED");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });
});

describe("the entanglement abort", () => {
  test("a deletable track in a mixtape aborts before any write", async () => {
    const s = stub((sql) => (sql.includes("from mixtape_tracks") ? [{ track_id: "t_solo1" }] : []));
    const { code, out } = await run(["--artists", "impostor", "--confirm"], namesake(s.client));

    expect(code).toBe(1);
    expect(out).toContain("ENTANGLEMENT: mixtape_tracks has 1");
    expect(out).toContain("ABORTED");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("a SURVIVING track in a mixtape is none of the guard's business", async () => {
    const s = stub((sql) =>
      sql.includes("from mixtape_tracks") ? [{ track_id: "t_shared" }] : [],
    );
    const { code, out } = await run(["--artists", "impostor", "--confirm"], namesake(s.client));

    expect(out).toContain("entanglement guard: clean");
    expect(code).toBe(0);
  });
});

describe("the dry run", () => {
  test("performs ZERO writes — every statement it issues is a read", async () => {
    const s = stub();
    const { code, out } = await run(["--artists", "impostor"], namesake(s.client));

    expect(code).toBe(0);
    expect(out).toContain("DRY RUN — nothing written");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
    // It DID read — the guard ran, so the absence of writes is not the absence of work.
    expect(s.executed.some((sql) => sql.includes("from mixtape_tracks"))).toBe(true);
  });

  test("an empty artist list is a no-op that never opens the catalogue", async () => {
    let loaded = false;
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));
    try {
      const code = await main([], async () => {
        loaded = true;

        return namesake(stub().client);
      });

      expect(code).toBe(0);
      expect(loaded).toBe(false);
    } finally {
      console.log = original;
    }
  });
});

describe("--confirm runs the shared cascade", () => {
  test("deletes children before parents and kills each track with its edges atomically", async () => {
    const s = stub();
    const { code } = await run(["--artists", "impostor", "--confirm"], namesake(s.client));

    expect(code).toBe(0);
    const writes = s.executed.filter(isWrite).map((sql) => sql.replaceAll(/\s+/g, " ").trim());
    expect(writes).toEqual([
      "delete from cost_events where track_id in (?,?)",
      "delete from artist_socials where artist_id in (?)",
      "delete from artist_aliases where artist_id in (?)",
      "delete from artist_centroids where artist_id in (?)",
      "delete from artist_similar where artist_id in (?)",
      "delete from artist_similar where neighbour_artist_id in (?)",
      // The purged artist's edge on the SURVIVING track, keyed by artist so `artists` can go.
      "delete from track_artists where artist_id in (?)",
      "delete from albums where id in (?)",
      "delete from artists where id in (?)",
    ]);
    // The tracks and THEIR edges never ride a bare execute — always one write transaction.
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.mode).toBe("write");
    expect(s.batches[0]?.stmts[0]?.sql).toBe("delete from track_artists where track_id in (?,?)");
    expect(s.batches[0]?.stmts[1]?.sql).toBe(
      "delete from track_embeddings where track_id in (?,?)",
    );
    expect(s.batches[0]?.stmts[2]?.sql).toBe("delete from tracks where track_id in (?,?)");
  });
});

describe("the artists file", () => {
  test("one slug per line, with `#` comments and blanks dropped", () => {
    expect(
      parseArtistsFile("impostor  # the 1978 punk namesake\n\n  guest\n# whole-line note\n"),
    ).toEqual(["impostor", "guest"]);
  });
});
