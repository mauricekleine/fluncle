import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { type Catalogue } from "./lib";
import { ARTIST_REFERENCES, main, planMerge, reconcile, referenceStatements } from "./merge-artist";

// The duplicate-row merge TOUCHES PRODUCTION — it deletes an `artists` row and re-points every
// reference to it — so nothing here may reach a real database. These drive a recording stub of the
// libSQL `Client` and pin the rails that decide whether the tool can do damage: the FINDINGS rule
// (both faces), the same-row aborts, that a dry-run performs ZERO writes, that no TRACK is ever
// deleted, and — the load-bearing one — that EVERY table referencing `artists.id` is settled.

type Row = Record<string, unknown>;
type Statement = { args?: unknown; sql: string };

type Stub = {
  batches: { mode?: string; stmts: Statement[] }[];
  client: Client;
  executed: string[];
};

/** Every statement that could change the database. A dry-run must issue none of these. */
const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

// Redirect the rollback snapshot before ANY test runs — in a real run that file is verbatim
// production rows, and the script defaults `PRUNE_OUT_DIR` to `.`.
process.env.PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "merge-artist-"));

const ARTIST_ROWS: Record<string, Row> = {
  A_CANON: { bio: null, id: "A_CANON", mbid: "mb-wrong", name: "Orion", slug: "orion" },
  A_DUP: { bio: null, id: "A_DUP", mbid: "mb-goa", name: "Orion", slug: "orion-2" },
};

function stub(rowsFor: (sql: string) => Row[] | undefined = () => undefined): Stub {
  const batches: Stub["batches"] = [];
  const executed: string[] = [];
  const client = {
    batch: async (stmts: Statement[], mode?: string) => {
      batches.push({ mode, stmts });

      return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
    },
    execute: async (stmt: Statement | string) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = (typeof stmt === "string" ? [] : (stmt.args as unknown[])) ?? [];
      executed.push(sql);

      const override = rowsFor(sql);

      if (override) {
        return { rows: override, rowsAffected: 1 };
      }

      // The two reads `main` cannot run without: the artists rows, and the hub-count census.
      if (/from artists where id = \?/.test(sql)) {
        const row = ARTIST_ROWS[String(args[0])];

        return { rows: row ? [row] : [], rowsAffected: 1 };
      }

      if (/count\(\*\) as renderable/.test(sql)) {
        return { rows: [{ certified: 0, renderable: 2 }], rowsAffected: 1 };
      }

      return { rows: [], rowsAffected: 1 };
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

function catalogue(spec: Spec): Catalogue {
  const artists = spec.artists.map((a) => ({ ...a, spotify_url: null }));

  return {
    albumName: new Map(),
    artistById: new Map(artists.map((a) => [a.id, a])),
    artists,
    db: spec.db,
    disabledSlugs: new Set<string>(),
    edges: spec.edges,
    enabledSlugs: new Set<string>(),
    findingTrackIds: new Set(spec.findingTrackIds ?? []),
    labels: [],
    trackById: new Map(spec.tracks.map((t) => [t.track_id, t])),
    trackDisabled: () => false,
    trackEnabled: () => false,
    tracks: spec.tracks,
  };
}

/**
 * The live duplicate pair, in miniature: `orion` and `orion-2` are the same act, they SHARE
 * `t_shared`, and each carries tracks the other does not.
 */
const duplicated = (db: Client, opts: { findingTrackIds?: string[] } = {}) =>
  catalogue({
    artists: [
      { id: "A_CANON", name: "Orion", slug: "orion" },
      { id: "A_DUP", name: "Orion", slug: "orion-2" },
      { id: "A_OTHER", name: "Someone Else", slug: "someone-else" },
    ],
    db,
    edges: [
      { artist_id: "A_CANON", track_id: "t_canon_only" },
      { artist_id: "A_CANON", track_id: "t_shared" },
      { artist_id: "A_DUP", track_id: "t_shared" },
      { artist_id: "A_DUP", track_id: "t_dup1" },
      { artist_id: "A_DUP", track_id: "t_dup2" },
      { artist_id: "A_OTHER", track_id: "t_other" },
    ],
    findingTrackIds: opts.findingTrackIds,
    tracks: [
      { album_id: null, label: "Vibez", title: "Control", track_id: "t_canon_only" },
      { album_id: null, label: "Looking Good", title: "Ol Janx Spirit", track_id: "t_shared" },
      { album_id: null, label: "Knowledge", title: "Isolation", track_id: "t_dup1" },
      { album_id: null, label: "Covert Ops", title: "She Breathes", track_id: "t_dup2" },
      { album_id: null, label: "Elsewhere", title: "Not Ours", track_id: "t_other" },
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
      () => "2026-07-27T00:00:00.000Z",
      () => "NEW_ID",
    );

    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

/** Every statement the run would send, `execute` and `batch` alike, whitespace-normalised. */
const writes = (s: Stub): string[] =>
  [...s.executed, ...s.batches.flatMap((b) => b.stmts.map((st) => st.sql))]
    .filter(isWrite)
    .map((sql) => sql.replaceAll(/\s+/g, " ").trim());

describe("planMerge", () => {
  test("splits the duplicate's credit into MOVING and COLLAPSING", () => {
    const plan = planMerge(duplicated(stub().client), "A_CANON", "A_DUP");

    expect(plan.movedTrackIds.sort()).toEqual(["t_dup1", "t_dup2"]);
    // The track BOTH rows credit is a double edge — it collapses, it does not move.
    expect(plan.collapsedTrackIds).toEqual(["t_shared"]);
  });

  test("a track only the canonical credits is none of the merge's business", () => {
    const plan = planMerge(duplicated(stub().client), "A_CANON", "A_DUP");

    expect(plan.movedTrackIds).not.toContain("t_canon_only");
    expect(plan.collapsedTrackIds).not.toContain("t_canon_only");
    // …and neither is a third artist's track.
    expect([...plan.movedTrackIds, ...plan.collapsedTrackIds]).not.toContain("t_other");
  });
});

describe("the findings rule", () => {
  test("a finding that would MOVE to a different page is a blocker", () => {
    const plan = planMerge(
      duplicated(stub().client, { findingTrackIds: ["t_dup1"] }),
      "A_CANON",
      "A_DUP",
    );

    expect(plan.findingBlockerTrackIds).toEqual(["t_dup1"]);
    expect(plan.findingInheritedTrackIds).toEqual([]);
  });

  test("a finding the canonical ALREADY credits inherits cleanly — no blocker", () => {
    const plan = planMerge(
      duplicated(stub().client, { findingTrackIds: ["t_shared"] }),
      "A_CANON",
      "A_DUP",
    );

    // Both rows sit on the track, so the merge only collapses a double credit and the finding's
    // artist page is unchanged. Nothing moves, so there is nothing to rule on.
    expect(plan.findingBlockerTrackIds).toEqual([]);
    expect(plan.findingInheritedTrackIds).toEqual(["t_shared"]);
  });

  test("a blocking finding aborts the whole run before any write", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client, { findingTrackIds: ["t_dup1"] }),
    );

    expect(code).toBe(1);
    expect(out).toContain("finding-bearing track(s) would MOVE");
    expect(writes(s)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("an inherited finding does NOT abort", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2"],
      duplicated(s.client, { findingTrackIds: ["t_shared"] }),
    );

    expect(code).toBe(0);
    expect(out).toContain("findings inherited cleanly: 1");
  });
});

describe("the same-row aborts", () => {
  test("identical slugs are refused without even opening the catalogue", async () => {
    let loaded = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main(["--canonical", "orion", "--duplicate", "orion"], async () => {
        loaded = true;

        return duplicated(stub().client);
      });

      expect(code).toBe(1);
      expect(loaded).toBe(false);
    } finally {
      console.log = original;
    }
  });

  test("an unknown canonical slug aborts", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "typo", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain(`no artists row for --canonical "typo"`);
    expect(writes(s)).toEqual([]);
  });

  test("an unknown duplicate slug aborts", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "orion", "--duplicate", "typo", "--confirm"],
      duplicated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain(`no artists row for --duplicate "typo"`);
    expect(writes(s)).toEqual([]);
  });

  test("no arguments is a no-op that never opens the catalogue", async () => {
    let loaded = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main([], async () => {
        loaded = true;

        return duplicated(stub().client);
      });

      expect(code).toBe(0);
      expect(loaded).toBe(false);
    } finally {
      console.log = original;
    }
  });
});

describe("the dry run", () => {
  test("performs ZERO writes and still reads every reference", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2"],
      duplicated(s.client),
    );

    expect(code).toBe(0);
    expect(out).toContain("DRY RUN — nothing written");
    expect(writes(s)).toEqual([]);
    expect(s.batches).toEqual([]);
    // The report is real work, not a guess: every reference was counted against the database.
    for (const ref of ARTIST_REFERENCES) {
      expect(s.executed.some((sql) => sql.includes(`select * from ${ref.table}`))).toBe(true);
    }
  });

  test("names the moved credit, the collapse, and the alias it would write", async () => {
    const { out } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2"],
      duplicated(stub().client),
    );

    expect(out).toContain("2 moving");
    expect(out).toContain("1 double edge(s) collapsing");
    expect(out).toContain("0 tracks deleted (never)");
    expect(out).toContain(`alias written: "Orion" (orion-2)`);
  });
});

describe("--confirm", () => {
  test("deletes the duplicate artists row FIRST, and never a track", async () => {
    const s = stub();
    const { code } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client),
    );

    expect(code).toBe(0);
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.mode).toBe("write");
    // Statement 0 frees the duplicate's UNIQUE slug + spotify_artist_id before anything adopts them.
    expect(s.batches[0]?.stmts[0]?.sql).toBe("delete from artists where id = ?");
    // A MERGE MOVES CREDIT. It must never destroy catalogue rows — that is what makes it reversible.
    expect(writes(s).some((sql) => /delete from tracks\b/.test(sql))).toBe(false);
    expect(writes(s).some((sql) => /delete from albums\b/.test(sql))).toBe(false);
  });

  test("writes the merged-away slug as a confirmed operator alias", async () => {
    const s = stub();
    await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client),
    );

    const alias = s.batches[0]?.stmts.find((st) => /insert into artist_aliases/.test(st.sql));
    expect(alias).toBeDefined();
    expect(alias?.sql).toContain("'operator', 'name', 'confirmed'");
    expect(alias?.sql).toContain("on conflict (artist_id, alias_slug, source) do nothing");
    expect(alias?.args).toEqual(["ala_NEW_ID", "A_CANON", "Orion", "orion-2", stampedAt]);
  });

  test("moves the hub counts by the censused delta, in the SAME transaction", async () => {
    const s = stub();
    await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client),
    );

    const hub = s.batches[0]?.stmts.find((st) => /renderable_track_count = max/.test(st.sql));
    expect(hub).toBeDefined();
    // The stubbed census answers 2 renderable / 0 certified — the two tracks that actually move.
    expect(hub?.args).toEqual([2, 0, "A_CANON"]);
  });

  test("--set-mbid overrides the identity and clears resolved_at for a re-walk", async () => {
    const s = stub();
    const { out } = await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--set-mbid", "mb-real", "--confirm"],
      duplicated(s.client),
    );

    const update = s.batches[0]?.stmts.find((st) => st.sql.startsWith("update artists set "));
    expect(update?.sql).toContain("mbid = ?");
    expect(update?.sql).toContain("resolved_at = ?");
    expect(update?.args).toContain("mb-real");
    expect(out).toContain("resolved_at CLEARED");
  });

  test("--drop-duplicate-socials deletes the channels instead of moving them", async () => {
    const s = stub();
    await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--drop-duplicate-socials", "--confirm"],
      duplicated(s.client),
    );

    const w = writes(s);
    expect(w).toContain("delete from artist_socials where artist_id = ?");
    // The re-point is gone — a different act's MB-sourced links never reach the survivor.
    expect(w).not.toContain(
      "update or ignore artist_socials set artist_id = ? where artist_id = ?",
    );
  });
});

const stampedAt = "2026-07-27T00:00:00.000Z";

describe("the repoint-only shape (--canonical + --set-mbid, no --duplicate)", () => {
  test("names itself as a repoint and touches NO reference", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "orion", "--set-mbid", "mb-real"],
      duplicated(s.client),
    );

    expect(code).toBe(0);
    expect(out).toContain("IDENTITY REPOINT (no merge)");
    expect(out).toContain("touches IDENTITY ONLY");
    // A repoint reads no reference table at all — there is no duplicate to sweep.
    for (const ref of ARTIST_REFERENCES) {
      expect(s.executed.some((sql) => sql.includes(`select * from ${ref.table}`))).toBe(false);
    }
    expect(writes(s)).toEqual([]);
  });

  test("--confirm writes ONLY the identity update — no delete, no alias, no hub count", async () => {
    const s = stub();
    const { code } = await run(
      ["--canonical", "orion", "--set-mbid", "mb-real", "--confirm"],
      duplicated(s.client),
    );

    expect(code).toBe(0);
    const stmts = s.batches[0]?.stmts ?? [];
    expect(stmts).toHaveLength(1);
    expect(stmts[0]?.sql).toContain("update artists set");
    expect(stmts[0]?.args).toContain("mb-real");
    // The row it was asked about is the ONLY row it may touch.
    expect(writes(s).some((sql) => sql.startsWith("delete from"))).toBe(false);
    expect(writes(s).some((sql) => /insert into artist_aliases/.test(sql))).toBe(false);
    expect(writes(s).some((sql) => /renderable_track_count/.test(sql))).toBe(false);
  });

  test("--canonical alone, with no --set-mbid, is a no-op that never opens the catalogue", async () => {
    let loaded = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main(["--canonical", "orion"], async () => {
        loaded = true;

        return duplicated(stub().client);
      });

      expect(code).toBe(0);
      expect(loaded).toBe(false);
    } finally {
      console.log = original;
    }
  });

  test("an unknown slug still aborts", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--canonical", "typo", "--set-mbid", "mb-real", "--confirm"],
      duplicated(s.client),
    );

    expect(code).toBe(1);
    expect(out).toContain(`no artists row for --canonical "typo"`);
    expect(writes(s)).toEqual([]);
  });
});

describe("reconcile", () => {
  test("CANONICAL WINS — a filled slot is never overwritten from the duplicate", () => {
    const { set } = reconcile({ mbid: "keep-me" }, { mbid: "loser" });

    expect(set.mbid).toBeUndefined();
  });

  test("an EMPTY canonical slot is filled from the duplicate", () => {
    const { filled, set } = reconcile({ mbid: null }, { mbid: "found-it" });

    expect(set.mbid).toBe("found-it");
    expect(filled).toContain("mbid");
  });

  test("a grouped field travels with its whole group or not at all", () => {
    const { set } = reconcile(
      { image_key: null },
      { image_key: "k", image_source: "spotify", image_state: "resolved", image_updated_at: "t" },
    );

    expect(set.image_key).toBe("k");
    expect(set.image_source).toBe("spotify");
    expect(set.image_state).toBe("resolved");
    // A stored key under a `pending` state would be re-walked by the image sweep — hence the group.
    expect(set.image_updated_at).toBe("t");
  });

  test("--set-mbid outranks a non-empty canonical AND a resolved_at taken from the duplicate", () => {
    const { filled, set } = reconcile(
      { mbid: "wrong", resolved_at: null },
      { mbid: "also-wrong", resolved_at: "2026-01-01" },
      "the-real-one",
    );

    expect(set.mbid).toBe("the-real-one");
    // The duplicate's stamp belongs to the OLD identity, so the re-walk wins.
    expect(set.resolved_at).toBeNull();
    expect(filled).not.toContain("resolved_at");
  });

  test("--set-mbid that matches the canonical leaves resolved_at alone", () => {
    const { set } = reconcile({ mbid: "same", resolved_at: "2026-01-01" }, {}, "same");

    expect(set.resolved_at).toBeUndefined();
  });
});

// ── THE COMPLETENESS PROOF ───────────────────────────────────────────────────────────────────────
//
// The merge's one non-negotiable invariant: after it runs, NO row anywhere still references the
// deleted duplicate. That holds only while `ARTIST_REFERENCES` lists every table carrying an
// `artists.id` — and a schema that grows, or a careless edit, silently breaks it.
//
// `REFERENCING_COLUMNS` below is the INDEPENDENT ground truth, transcribed from
// apps/web/src/db/schema.ts and re-verified against the live production schema (2026-07-27) by
// scanning `sqlite_master` for every `%artist%` column plus every `entity_id` column. It is
// deliberately a SECOND copy: delete an entry from `ARTIST_REFERENCES` in the tool and both tests
// below fail — the coverage check because the map no longer spans the truth, and the sweep check
// because the emitted batch no longer clears that table.
const REFERENCING_COLUMNS = [
  "track_artists.artist_id",
  "artist_socials.artist_id",
  "artist_aliases.artist_id",
  "artist_centroids.artist_id",
  "artist_similar.artist_id",
  "artist_similar.neighbour_artist_id",
  "user_watches.entity_id",
].sort();

describe("re-point completeness", () => {
  test("ARTIST_REFERENCES spans every table that carries an artists.id", () => {
    const mapped = ARTIST_REFERENCES.map((r) => `${r.table}.${r.column}`).sort();

    expect(mapped).toEqual(REFERENCING_COLUMNS);
  });

  test("every reference emits a terminal DELETE, so nothing can be stranded", async () => {
    const s = stub();
    await run(
      ["--canonical", "orion", "--duplicate", "orion-2", "--confirm"],
      duplicated(s.client),
    );

    const w = writes(s);

    for (const column of REFERENCING_COLUMNS) {
      const [table, col] = column.split(".");
      const swept = w.some((sql) =>
        new RegExp(`^delete from ${table} where ${col} = \\?`).test(sql),
      );

      expect(swept, `${column} is never cleared of the duplicate's rows`).toBe(true);
    }
  });

  test("the polymorphic watch carries its kind filter on EVERY statement", () => {
    const watch = ARTIST_REFERENCES.find((r) => r.table === "user_watches");
    const stmts = referenceStatements(
      watch ?? { column: "entity_id", mode: "repoint", table: "user_watches" },
      "A_CANON",
      "A_DUP",
    );

    // Without it a merge would re-point a LABEL watch that happens to share the artist's uuid.
    expect(stmts).toHaveLength(2);
    for (const st of stmts) {
      expect(st.sql).toContain(`kind = 'artist'`);
    }
  });

  test("a repoint is or-ignore then swept; a drop is delete-only", () => {
    const repoint = referenceStatements(
      { column: "artist_id", mode: "repoint", table: "track_artists" },
      "A_CANON",
      "A_DUP",
    );
    expect(repoint.map((s) => s.sql)).toEqual([
      "update or ignore track_artists set artist_id = ? where artist_id = ?",
      "delete from track_artists where artist_id = ?",
    ]);

    const drop = referenceStatements(
      { column: "artist_id", mode: "drop", table: "artist_centroids" },
      "A_CANON",
      "A_DUP",
    );
    expect(drop.map((s) => s.sql)).toEqual(["delete from artist_centroids where artist_id = ?"]);
  });
});
