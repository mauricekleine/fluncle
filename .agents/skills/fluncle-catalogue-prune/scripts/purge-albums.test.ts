import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { type Client } from "@libsql/client/web";

import { type Catalogue } from "./lib";
import { main, planAlbumPurge } from "./purge-albums";

type Statement = { args?: unknown; sql: string };

const isWrite = (sql: string): boolean => /^\s*(delete|insert|replace|update)\b/i.test(sql);

const PRUNE_OUT_DIR = mkdtempSync(join(tmpdir(), "prune-albums-"));
process.env.PRUNE_OUT_DIR = PRUNE_OUT_DIR;

afterAll(() => {
  rmSync(PRUNE_OUT_DIR, { force: true, recursive: true });
});

function stub() {
  const batches: Statement[][] = [];
  const executed: string[] = [];
  const client = {
    batch: async (stmts: Statement[]) => {
      batches.push(stmts);

      return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
    },
    execute: async (stmt: Statement | string) => {
      executed.push(typeof stmt === "string" ? stmt : stmt.sql);

      return { rows: [], rowsAffected: 1 };
    },
  };

  return { batches, client: client as unknown as Client, executed };
}

function christmas(db: Client, findingTrackIds: string[] = []): Catalogue {
  const artists = [
    { id: "A_CROONER", name: "Crooner", slug: "crooner", spotify_url: null },
    { id: "A_DUET", name: "Duet Partner", slug: "duet-partner", spotify_url: null },
    { id: "A_REMIXED", name: "Remixed Singer", slug: "remixed-singer", spotify_url: null },
  ];
  const tracks = [
    { album_id: "al_xmas", label: "Penny Black", title: "Silent Night", track_id: "t_solo" },
    { album_id: "al_xmas", label: "Penny Black", title: "White Christmas", track_id: "t_duet" },
    { album_id: "al_xmas", label: "Penny Black", title: "Jingle Bells", track_id: "t_remixed" },
    {
      album_id: "al_dnb",
      label: "Swing & Bass",
      title: "Jingle Bells (DnB remix)",
      track_id: "t_dnb_remix",
    },
  ];

  return {
    albumName: new Map([
      ["al_xmas", "We Wish You a Merry Christmas"],
      ["al_dnb", "Swing & Bass Vol. 1"],
    ]),
    artistById: new Map(artists.map((a) => [a.id, a])),
    artists,
    db,
    disabledSlugs: new Set(),
    edges: [
      { artist_id: "A_CROONER", track_id: "t_solo" },
      { artist_id: "A_CROONER", track_id: "t_duet" },
      { artist_id: "A_DUET", track_id: "t_duet" },
      { artist_id: "A_REMIXED", track_id: "t_remixed" },
      { artist_id: "A_REMIXED", track_id: "t_dnb_remix" },
    ],
    enabledSlugs: new Set(["penny-black", "swing-bass"]),
    findingTrackIds: new Set(findingTrackIds),
    labels: [],
    trackById: new Map(tracks.map((t) => [t.track_id, t])),
    trackDisabled: () => false,
    trackEnabled: () => true,
    tracks,
  };
}

async function run(argv: string[], cat: Catalogue): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { code: await main(argv, async () => cat), out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("an album purge takes the whole album", () => {
  test("every track on the album is deletable, including a co-credited duet", () => {
    const plan = planAlbumPurge(christmas(stub().client), ["al_xmas"]);

    expect(plan.trackIds.sort()).toEqual(["t_duet", "t_remixed", "t_solo"]);
  });

  test("an artist whose every track is on the album goes with it", () => {
    const plan = planAlbumPurge(christmas(stub().client), ["al_xmas"]);

    expect(plan.orphanArtistIds.sort()).toEqual(["A_CROONER", "A_DUET"]);
  });

  test("an artist with a track on another album keeps their row and that track", () => {
    const plan = planAlbumPurge(christmas(stub().client), ["al_xmas"]);

    expect(plan.orphanArtistIds).not.toContain("A_REMIXED");
    expect(plan.trackIds).not.toContain("t_dnb_remix");
  });
});

describe("a named-track purge", () => {
  test("deletes only the named tracks and keeps a co-credited artist who has other music", () => {
    const plan = planAlbumPurge(christmas(stub().client), [], ["t_remixed"]);

    expect(plan.trackIds).toEqual(["t_remixed"]);
    expect(plan.orphanArtistIds).toEqual([]);
    expect(plan.albumIds).toEqual([]);
  });

  test("an album emptied by the named tracks goes with them", () => {
    const plan = planAlbumPurge(christmas(stub().client), [], ["t_solo", "t_duet", "t_remixed"]);

    expect(plan.albumIds).toEqual(["al_xmas"]);
  });

  test("an unknown track id aborts with zero writes", async () => {
    const s = stub();
    const { code, out } = await run(["--tracks", "t_missing", "--confirm"], christmas(s.client));

    expect(code).toBe(1);
    expect(out).toContain("t_missing");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });

  test("a named findings track aborts with zero writes", async () => {
    const s = stub();
    const { code } = await run(
      ["--tracks", "t_duet", "--confirm"],
      christmas(s.client, ["t_duet"]),
    );

    expect(code).toBe(1);
    expect(s.executed.filter(isWrite)).toEqual([]);
  });
});

describe("the hard aborts", () => {
  test("an album holding a findings track aborts with zero writes", async () => {
    const s = stub();
    const { code, out } = await run(
      ["--albums", "al_xmas", "--confirm"],
      christmas(s.client, ["t_solo"]),
    );

    expect(code).toBe(1);
    expect(out).toContain("FINDING");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("an unknown album id aborts with zero writes", async () => {
    const s = stub();
    const { code, out } = await run(["--albums", "al_missing", "--confirm"], christmas(s.client));

    expect(code).toBe(1);
    expect(out).toContain("al_missing");
    expect(s.executed.filter(isWrite)).toEqual([]);
  });
});

describe("the dry run", () => {
  test("names the album and its credits and writes nothing", async () => {
    const s = stub();
    const { code, out } = await run(["--albums", "al_xmas"], christmas(s.client));

    expect(code).toBe(0);
    expect(out).toContain("We Wish You a Merry Christmas");
    expect(out).toContain("Duet Partner");
    expect(out).toContain("DRY RUN");
    expect(s.executed.filter(isWrite)).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  test("the confirmed run deletes the album's tracks and its orphaned artists", async () => {
    const s = stub();
    const { code } = await run(["--albums", "al_xmas", "--confirm"], christmas(s.client));

    expect(code).toBe(0);
    expect(s.executed.some((sql) => /delete from albums/i.test(sql))).toBe(true);
    expect(s.executed.some((sql) => /delete from artists/i.test(sql))).toBe(true);
    expect(s.batches.flat().some((stmt) => /delete from tracks/i.test(stmt.sql))).toBe(true);
  });
});
