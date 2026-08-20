import { describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import {
  insertStatements,
  main,
  parseTrackArg,
  planRestore,
  type Rollback,
} from "./restore-from-rollback";

// The restore WRITES TO PRODUCTION, so nothing here may reach a real database. These pin the rails
// that decide whether it can do damage: the wrong-file abort, idempotence (`insert or ignore`), the
// schema-drift guard, that a dry-run performs ZERO writes, and that it never touches a table it was
// not asked about.

type Statement = { args?: unknown; sql: string };

type Stub = {
  batches: { mode?: string; stmts: Statement[] }[];
  client: Client;
  executed: string[];
};

const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

function stub(columns: Record<string, string[]> = {}): Stub {
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

      const info = /pragma table_info\((\w+)\)/.exec(sql);

      if (info) {
        const table = info[1] ?? "";
        const names = columns[table] ?? DEFAULT_COLUMNS[table] ?? [];

        return { rows: names.map((name) => ({ name })), rowsAffected: 0 };
      }

      return { rows: [], rowsAffected: 0 };
    },
  };

  return { batches, client: client as unknown as Client, executed };
}

const DEFAULT_COLUMNS: Record<string, string[]> = {
  albums: ["id", "name", "slug"],
  artists: ["id", "name", "slug"],
  track_artists: ["track_id", "artist_id", "position"],
  tracks: ["track_id", "title", "artists_json", "album", "label", "album_id", "isrc"],
};

const ROLLBACK: Rollback = {
  albums: [{ id: "alb_hitdecks", name: "Hit the Decks, Volume 1", slug: "hit-the-decks-volume-1" }],
  artists: [{ id: "A_SL2", name: "SL2", slug: "sl2" }],
  track_artists: [{ artist_id: "A_SL2", position: 0, track_id: "t_sl2" }],
  tracks: [
    {
      album: "Hit the Decks, Volume 1",
      album_id: "alb_hitdecks",
      artists_json: '["SL2"]',
      label: "Planet Earth Recordings",
      title: "SL2 Megamix",
      track_id: "t_sl2",
    },
    {
      album: "Hit the Decks, Volume 1",
      album_id: "alb_hitdecks",
      artists_json: '["Carl Cox"]',
      label: "Planet Earth Recordings",
      title: "Carl Cox Megamix",
      track_id: "t_cox",
    },
  ],
};

async function run(argv: string[], s: Stub, rollback = ROLLBACK) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await main(
      argv,
      async () => s.client,
      () => rollback,
    );

    return { code, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

const writes = (s: Stub): string[] =>
  [...s.executed, ...s.batches.flatMap((b) => b.stmts.map((st) => st.sql))]
    .filter(isWrite)
    .map((sql) => sql.replaceAll(/\s+/g, " ").trim());

describe("planRestore", () => {
  test("restores ONLY the named tracks, not the whole file", () => {
    const plan = planRestore(ROLLBACK, ["t_sl2"]);

    expect(plan.tracks.map((t) => t.track_id)).toEqual(["t_sl2"]);
    // The purge's other victim stays deleted — that is the whole point of naming ids.
    expect(plan.tracks.map((t) => t.track_id)).not.toContain("t_cox");
  });

  test("closes over the track's album and its credited artists", () => {
    const plan = planRestore(ROLLBACK, ["t_sl2"]);

    expect(plan.albums.map((a) => a.id)).toEqual(["alb_hitdecks"]);
    expect(plan.artists.map((a) => a.id)).toEqual(["A_SL2"]);
    expect(plan.edges).toHaveLength(1);
  });

  test("a track with no captured edges restores with no artist credit", () => {
    // The edgeless purge deleted tracks that HAD no `track_artists` edge, so its rollback carries
    // neither `artists` nor `track_artists`. Restoring must not invent either.
    const plan = planRestore({ tracks: ROLLBACK.tracks }, ["t_cox"]);

    expect(plan.tracks).toHaveLength(1);
    expect(plan.edges).toEqual([]);
    expect(plan.artists).toEqual([]);
    expect(plan.albums).toEqual([]);
  });

  test("an id the file does not hold is reported, never silently skipped", () => {
    const plan = planRestore(ROLLBACK, ["t_sl2", "t_not_here"]);

    expect(plan.missingTrackIds).toEqual(["t_not_here"]);
  });
});

describe("parseTrackArg", () => {
  test("splits a comma or space separated list", () => {
    expect(parseTrackArg("a, b  c", ROLLBACK)).toEqual(["a", "b", "c"]);
  });

  test("`all` means every track the file holds", () => {
    expect(parseTrackArg("all", ROLLBACK)).toEqual(["t_sl2", "t_cox"]);
  });
});

describe("insertStatements", () => {
  test("is `insert or ignore`, so a row already live is never clobbered", () => {
    const [stmt] = insertStatements(
      "tracks",
      [{ title: "x", track_id: "t" }],
      new Set(["track_id", "title"]),
    );

    expect(stmt?.sql).toContain("insert or ignore into tracks");
  });

  test("SCHEMA DRIFT: a column the live table no longer has is dropped from the insert", () => {
    const [stmt] = insertStatements(
      "tracks",
      [{ gone_since: "old", title: "x", track_id: "t" }],
      new Set(["track_id", "title"]),
    );

    expect(stmt?.sql).not.toContain("gone_since");
    // Columns keep the snapshot row's own order, minus the dropped one — so do their args.
    expect(stmt?.sql).toContain("(title, track_id)");
    expect(stmt?.args).toEqual(["x", "t"]);
  });
});

describe("the wrong-file abort", () => {
  test("a requested id absent from the rollback aborts before any write", async () => {
    const s = stub();
    const { code, out } = await run(["--rollback", "f.json", "--tracks", "t_nope", "--confirm"], s);

    expect(code).toBe(1);
    expect(out).toContain("not in this rollback file");
    expect(writes(s)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("an unreadable rollback file aborts", async () => {
    const s = stub();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const code = await main(
        ["--rollback", "missing.json", "--tracks", "t_sl2"],
        async () => s.client,
        () => {
          throw new Error("ENOENT");
        },
      );

      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("could not read the rollback file");
    } finally {
      console.log = original;
    }
  });

  test("no arguments is a no-op that never opens the database", async () => {
    let opened = false;
    const original = console.log;
    console.log = () => {};
    try {
      const code = await main([], async () => {
        opened = true;

        return stub().client;
      });

      expect(code).toBe(0);
      expect(opened).toBe(false);
    } finally {
      console.log = original;
    }
  });
});

describe("the dry run", () => {
  test("performs ZERO writes and still reports what is already live", async () => {
    const s = stub();
    const { code, out } = await run(["--rollback", "f.json", "--tracks", "t_sl2"], s);

    expect(code).toBe(0);
    expect(out).toContain("DRY RUN — nothing written");
    expect(out).toContain("SL2 Megamix");
    expect(writes(s)).toEqual([]);
    expect(s.batches).toEqual([]);
  });
});

describe("--confirm", () => {
  test("inserts parents before children, each in a write transaction", async () => {
    const s = stub();
    const { code } = await run(["--rollback", "f.json", "--tracks", "t_sl2", "--confirm"], s);

    expect(code).toBe(0);
    const tables = s.batches.map(
      (b) => /insert or ignore into (\w+)/.exec(b.stmts[0]?.sql ?? "")?.[1],
    );
    expect(tables).toEqual(["albums", "artists", "tracks", "track_artists"]);
    for (const batch of s.batches) {
      expect(batch.mode).toBe("write");
    }

    const trackBatch = s.batches.find((batch) =>
      /insert or ignore into tracks/.test(batch.stmts[0]?.sql ?? ""),
    );
    expect(trackBatch?.stmts[1]?.sql).toContain("insert into track_duplicate_keys");
  });

  test("NOTHING is ever deleted or updated — a restore only inserts", async () => {
    const s = stub();
    await run(["--rollback", "f.json", "--tracks", "t_sl2", "--confirm"], s);

    for (const sql of writes(s)) {
      expect(
        sql.startsWith("insert or ignore into") ||
          sql.startsWith("insert into track_duplicate_keys"),
      ).toBe(true);
    }
  });

  test("cost_events is never restored — that spend already happened", async () => {
    const s = stub();
    await run(["--rollback", "f.json", "--tracks", "t_sl2", "--confirm"], s);

    expect(writes(s).some((sql) => sql.includes("cost_events"))).toBe(false);
  });

  test("a section the file does not carry is skipped, not faked", async () => {
    const s = stub();
    await run(["--rollback", "f.json", "--tracks", "t_cox", "--confirm"], s, {
      tracks: ROLLBACK.tracks,
    });

    const tables = s.batches.map(
      (b) => /insert or ignore into (\w+)/.exec(b.stmts[0]?.sql ?? "")?.[1],
    );
    expect(tables).toEqual(["tracks"]);
  });

  test("SCHEMA DRIFT is reported rather than thrown", async () => {
    // The live `tracks` table has lost the `label` column the snapshot carries.
    const s = stub({ tracks: ["track_id", "title", "album", "album_id"] });
    const { code, out } = await run(["--rollback", "f.json", "--tracks", "t_sl2", "--confirm"], s);

    expect(code).toBe(0);
    expect(out).toContain("the live table no longer has");
    expect(out).toContain("label");
    const trackInsert = s.batches.find((b) => /into tracks/.test(b.stmts[0]?.sql ?? ""));
    expect(trackInsert?.stmts[0]?.sql).not.toContain("label");
  });
});
