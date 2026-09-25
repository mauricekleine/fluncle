import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { type Catalogue } from "./lib";
import { main, mintSlug, planSplit } from "./split-artist";

type Row = Record<string, unknown>;
type Statement = { args?: unknown; sql: string };

type Stub = {
  batches: { mode?: string; stmts: Statement[] }[];
  client: Client;
  executed: string[];
};

const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

const PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "split-artist-"));
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

type Spec = {
  artists: { id: string; name: string; slug: string }[];
  db: Client;
  edges: { artist_id: string; track_id: string }[];
  findingTrackIds?: string[];
  tracks: { album_id: null | string; label: null | string; title: string; track_id: string }[];
};

const slug = (s: null | string) => (s ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

function catalogue(spec: Spec): Catalogue {
  const artists = spec.artists.map((a) => ({ ...a, spotify_url: null }));
  const enabledSlugs = new Set(["cutting-edge", "audio-couture"]);

  return {
    albumName: new Map(),
    artistById: new Map(artists.map((a) => [a.id, a])),
    artists,
    db: spec.db,
    disabledSlugs: new Set<string>(),
    edges: spec.edges,
    enabledSlugs,
    findingTrackIds: new Set(spec.findingTrackIds ?? []),
    labels: [...enabledSlugs].map((s) => ({ id: s, name: s, seed_state: "enabled", slug: s })),
    trackById: new Map(spec.tracks.map((t) => [t.track_id, t])),
    trackDisabled: () => false,
    trackEnabled: (t) => Boolean(t.label && enabledSlugs.has(slug(t.label))),
    tracks: spec.tracks,
  };
}

const conflated = (db: Client, opts: { findingTrackIds?: string[] } = {}) =>
  catalogue({
    artists: [
      { id: "A_K", name: "K", slug: "k" },
      { id: "A_GUEST", name: "Innocent Guest", slug: "guest" },
    ],
    db,
    edges: [
      { artist_id: "A_K", track_id: "t_jpop1" },
      { artist_id: "A_K", track_id: "t_jpop2" },
      { artist_id: "A_K", track_id: "t_shared" },
      { artist_id: "A_GUEST", track_id: "t_shared" },
      { artist_id: "A_K", track_id: "t_dnb1" },
    ],
    findingTrackIds: opts.findingTrackIds,
    tracks: [
      { album_id: "al_jpop", label: "Cutting Edge", title: "Shiny days", track_id: "t_jpop1" },
      { album_id: "al_jpop", label: "Cutting Edge", title: "Echo", track_id: "t_jpop2" },
      { album_id: "al_mix", label: "Cutting Edge", title: "Split Bill", track_id: "t_shared" },
      { album_id: "al_dnb", label: "Audio Couture", title: "Bad Dream", track_id: "t_dnb1" },
    ],
  });

async function run(argv: string[], cat: Catalogue): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(
      argv,
      async () => cat,
      () => "NEW_ID",
    );

    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("planSplit", () => {
  test("splits the artist's tracks by label into impostor / kept", () => {
    const plan = planSplit(conflated(stub().client), "A_K", new Set(["cutting-edge"]));

    expect(plan.impostorTrackIds.sort()).toEqual(["t_jpop1", "t_jpop2"]);
    expect(plan.keptTrackIds).toContain("t_dnb1");
  });

  test("a co-credited impostor-side track is HELD BACK, never moved", () => {
    const plan = planSplit(conflated(stub().client), "A_K", new Set(["cutting-edge"]));

    expect(plan.sharedTrackIds).toEqual(["t_shared"]);
    expect(plan.impostorTrackIds).not.toContain("t_shared");

    expect(plan.keptTrackIds).toContain("t_shared");
  });

  test("a FINDING on the impostor side is never in the movable set", () => {
    const plan = planSplit(
      conflated(stub().client, { findingTrackIds: ["t_jpop1"] }),
      "A_K",
      new Set(["cutting-edge"]),
    );

    expect(plan.impostorTrackIds).toEqual(["t_jpop2"]);
    expect(plan.keptTrackIds).toContain("t_jpop1");
  });

  test("an album losing every track is orphaned; a half-emptied one is not", () => {
    const plan = planSplit(conflated(stub().client), "A_K", new Set(["cutting-edge"]));

    expect(plan.albumIds).toEqual(["al_jpop"]);
  });
});

describe("mintSlug", () => {
  test("takes the bare slug when it is free", () => {
    expect(mintSlug("K.", new Set())).toBe("k");
  });

  test("salts past a collision, the server's -2/-3 shape", () => {
    expect(mintSlug("K.", new Set(["k"]))).toBe("k-2");
    expect(mintSlug("K.", new Set(["k", "k-2"]))).toBe("k-3");
  });
});

describe("the not-actually-conflated abort", () => {
  test("an artist with NOTHING outside the impostor labels is refused", async () => {
    const s = stub();
    const cat = catalogue({
      artists: [{ id: "A_ONLY", name: "Only", slug: "only" }],
      db: s.client,
      edges: [{ artist_id: "A_ONLY", track_id: "t1" }],
      tracks: [{ album_id: null, label: "Cutting Edge", title: "Solo", track_id: "t1" }],
    });
    const { code, out } = await run(
      ["--artist", "only", "--labels", "cutting-edge", "--strip", "--confirm"],
      cat,
    );

    expect(code).toBe(1);
    expect(out).toContain("not a conflated");
    expect(out).toContain("purge-artists.ts");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });

  test("an unknown slug aborts before any read of the plan", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artist", "typo", "--labels", "cutting-edge", "--strip", "--confirm"],
      conflated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain("no artists row");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });

  test("labels that match nothing abort rather than silently doing nothing", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artist", "k", "--labels", "not-a-label", "--strip", "--confirm"],
      conflated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain("nothing on the impostor side");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });
});

describe("the findings abort", () => {
  test("a finding among the movable tracks aborts the whole run", async () => {
    const s = stub();
    const cat = conflated(s.client, { findingTrackIds: ["t_jpop1", "t_jpop2"] });
    const { code } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip", "--confirm"],
      cat,
    );

    expect(code).toBe(1);
    expect(s.executed.filter(isWrite)).toEqual([]);
  });
});

describe("the entanglement abort (strip only)", () => {
  test("an impostor track in a mixtape aborts before any write", async () => {
    const s = stub((sql) => (sql.includes("from mixtape_tracks") ? [{ track_id: "t_jpop1" }] : []));
    const { code, out } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip", "--confirm"],
      conflated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain("ENTANGLEMENT: mixtape_tracks has 1");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("a KEPT track in a mixtape is none of the guard's business", async () => {
    const s = stub((sql) => (sql.includes("from mixtape_tracks") ? [{ track_id: "t_dnb1" }] : []));
    const { code, out } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip", "--confirm"],
      conflated(s.client),
    );

    expect(out).toContain("entanglement guard: clean");
    expect(code).toBe(0);
  });
});

describe("the dry run", () => {
  test("STRIP performs ZERO writes and still runs the guard", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip"],
      conflated(s.client),
    );

    expect(code).toBe(0);
    expect(out).toContain("DRY RUN — nothing written");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
    expect(s.executed.some((sql) => sql.includes("from mixtape_tracks"))).toBe(true);
  });

  test("SPLIT performs ZERO writes and names the row it would mint", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--into", "K."],
      conflated(s.client),
    );

    expect(code).toBe(0);
    expect(out).toContain("new artist row");

    expect(out).toContain("k-2");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });

  test("a split without --into refuses rather than guessing a name", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--artist", "k", "--labels", "cutting-edge"],
      conflated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain("--into");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });

  test("no arguments is a no-op that never opens the catalogue", async () => {
    let loaded = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main([], async () => {
        loaded = true;

        return conflated(stub().client);
      });

      expect(code).toBe(0);
      expect(loaded).toBe(false);
    } finally {
      console.log = original;
    }
  });
});

describe("--confirm", () => {
  test("SPLIT mints the new artist then re-points ONLY the impostor edges", async () => {
    const s = stub();
    const { code } = await run(
      [
        "--artist",
        "k",
        "--labels",
        "cutting-edge",
        "--into",
        "K.",
        "--into-mbid",
        "mb-jpop",
        "--confirm",
      ],
      conflated(s.client),
    );

    expect(code).toBe(0);
    const writes = s.executed.filter(isWrite).map((sql) => sql.replaceAll(/\s+/g, " ").trim());
    expect(writes).toEqual([
      "insert into artists (id, name, slug, mbid, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      "update track_artists set artist_id = ? where artist_id = ? and track_id in (?,?)",
    ]);

    expect(s.executed.some((sql) => sql.includes("delete from tracks"))).toBe(false);
  });

  test("STRIP deletes the tracks and their edges in ONE write transaction", async () => {
    const s = stub();
    const { code } = await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip", "--confirm"],
      conflated(s.client),
    );

    expect(code).toBe(0);
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.mode).toBe("write");
    expect(s.batches[0]?.stmts[0]?.sql).toBe("delete from track_artists where track_id in (?,?)");
    expect(s.batches[0]?.stmts[1]?.sql).toBe(
      "delete from track_embeddings where track_id in (?,?)",
    );
    expect(s.batches[0]?.stmts[2]?.sql).toBe("delete from tracks where track_id in (?,?)");

    expect(s.executed.some((sql) => /delete from artists\b/.test(sql))).toBe(false);
  });

  test("STRIP deletes the orphaned album but not the half-emptied one", async () => {
    const s = stub();
    await run(
      ["--artist", "k", "--labels", "cutting-edge", "--strip", "--confirm"],
      conflated(s.client),
    );

    const albumDeletes = s.executed.filter((sql) => /delete from albums/.test(sql));
    expect(albumDeletes).toHaveLength(1);
  });
});
