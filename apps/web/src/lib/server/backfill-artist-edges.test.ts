import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return {
    ...actual,
    getDb: async () => ({
      batch: async (statements: Array<{ args?: unknown[]; sql: string }>) =>
        Promise.all(statements.map((statement) => execute(statement))),
      execute,
    }),
  };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./due-work-cutover", () => ({
  isDueWorkCutoverEnabled: async () => false,
  readPromotedDueWorkPage: vi.fn(),
}));

const { buildArtistFoldMap, buildIdentityClaimedNames, matchTrackNames, resolveArtistEdges } =
  await import("./backfill-artist-edges");

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ rows: [], rowsAffected: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildArtistFoldMap", () => {
  it("keys artists by their FOLDED name (case/accent/punctuation-insensitive)", () => {
    const map = buildArtistFoldMap([{ id: "art-1", name: "Nu:Tone" }], []);

    expect(map.get("nu tone")).toBe("art-1");
  });

  it("folds an alias onto its artist (auto|confirmed AKAs)", () => {
    const map = buildArtistFoldMap(
      [{ id: "art-1", name: "Danny Byrd" }],
      [{ alias: "DB", artist_id: "art-1" }],
    );

    expect(map.get("danny byrd")).toBe("art-1");
    expect(map.get("db")).toBe("art-1");
  });

  it("a primary name BEATS an alias for the same fold (never ambiguated by an alias)", () => {
    const map = buildArtistFoldMap(
      [{ id: "art-real", name: "Netsky" }],
      [{ alias: "Netsky", artist_id: "art-other" }],
    );

    expect(map.get("netsky")).toBe("art-real");
  });

  it("a fold two DISTINCT identities share is ambiguous → matches nothing (fail-closed)", () => {
    const map = buildArtistFoldMap(
      [
        { id: "art-a", name: "Nucleus" },
        { id: "art-b", name: "Nucleus" },
      ],
      [],
    );

    expect(map.has("nucleus")).toBe(false);
  });

  it("a name that folds to empty is dropped, never a blank key", () => {
    const map = buildArtistFoldMap([{ id: "art-1", name: "!!!" }], []);

    expect(map.has("")).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("matchTrackNames", () => {
  const map = new Map<string, string>([
    ["logistics", "art-logi"],
    ["nu tone", "art-nutone"],
  ]);

  it("EXACT fold hit → one edge per distinct artist, 1-based array position", () => {
    const match = matchTrackNames(["Logistics", "Nu:Tone"], map);

    expect(match.edges).toEqual([
      { artistId: "art-logi", position: 1 },
      { artistId: "art-nutone", position: 2 },
    ]);
    expect(match.matchedNames).toBe(2);
    expect(match.totalNames).toBe(2);
  });

  it("a MISS leaves the name unmatched (partial classification)", () => {
    const match = matchTrackNames(["Logistics", "Some Unknown Artist"], map);

    expect(match.edges).toEqual([{ artistId: "art-logi", position: 1 }]);
    expect(match.matchedNames).toBe(1);
    expect(match.totalNames).toBe(2);
  });

  it("no name matches → zero edges (zero-match classification)", () => {
    const match = matchTrackNames(["Nobody", "Nowhere"], map);

    expect(match.edges).toEqual([]);
    expect(match.matchedNames).toBe(0);
    expect(match.totalNames).toBe(2);
  });

  it("the same artist credited twice yields ONE edge (first position wins)", () => {
    const match = matchTrackNames(["Logistics", "logistics"], map);

    expect(match.edges).toEqual([{ artistId: "art-logi", position: 1 }]);
    expect(match.matchedNames).toBe(2);
  });

  it("empty names count toward neither total nor matched", () => {
    const match = matchTrackNames(["Logistics", "", "  "], map);

    expect(match.totalNames).toBe(1);
    expect(match.matchedNames).toBe(1);
  });
});

describe("buildIdentityClaimedNames", () => {
  const aliases = [{ alias: "Kay", artist_id: "art-k" }];

  it("indexes ONLY artists that carry an mbid, by fold, with their real spellings", () => {
    const claimed = buildIdentityClaimedNames(
      [
        { id: "art-k", mbid: "mb-k-dnb", name: "K" },
        { id: "art-open", mbid: null, name: "Luna" },
      ],
      aliases,
    );

    expect(claimed.get("k")).toEqual(new Set(["k"]));
    expect(claimed.get("kay")).toEqual(new Set(["kay"]));

    expect(claimed.has("luna")).toBe(false);
  });

  it("an alias of an UNCLAIMED artist is not indexed either", () => {
    const claimed = buildIdentityClaimedNames(
      [{ id: "art-open", mbid: null, name: "K" }],
      [{ alias: "Kay", artist_id: "art-open" }],
    );

    expect(claimed.size).toBe(0);
  });
});

describe("matchTrackNames — the identity spelling rail", () => {
  const map = new Map<string, string>([
    ["k", "art-k"],
    ["kay", "art-k"],
  ]);
  const claimed = buildIdentityClaimedNames(
    [{ id: "art-k", mbid: "mb-k-dnb", name: "K" }],
    [{ alias: "Kay", artist_id: "art-k" }],
  );

  it('REFUSES a punctuation-only near-miss onto an identity-claimed row ("K." ⇏ K)', () => {
    const match = matchTrackNames(["K."], map, claimed);

    expect(match.edges).toEqual([]);

    expect(match.matchedNames).toBe(0);
    expect(match.totalNames).toBe(1);
  });

  it("still matches the artist's OWN spelling, case-insensitively", () => {
    expect(matchTrackNames(["k"], map, claimed).edges).toEqual([
      { artistId: "art-k", position: 1 },
    ]);
  });

  it("still matches a TRUSTED ALIAS spelling", () => {
    expect(matchTrackNames(["Kay"], map, claimed).edges).toEqual([
      { artistId: "art-k", position: 1 },
    ]);
  });

  it("leaves an UNCLAIMED row's historical fold latitude untouched", () => {
    const open = buildIdentityClaimedNames([{ id: "art-k", mbid: null, name: "K" }], []);

    expect(matchTrackNames(["K."], map, open).edges).toEqual([{ artistId: "art-k", position: 1 }]);
  });

  it("omitting the rail entirely is the historical behaviour", () => {
    expect(matchTrackNames(["K."], map).edges).toEqual([{ artistId: "art-k", position: 1 }]);
  });
});

describe("resolveArtistEdges", () => {
  function primeCorpus() {
    execute.mockResolvedValueOnce({ rows: [{ id: "art-logi", name: "Logistics" }] });
    execute.mockResolvedValueOnce({ rows: [{ alias: "Nu Tone", artist_id: "art-nutone" }] });
  }

  it("classifies a batch (full / partial / zero) and writes the matched edges", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { artists_json: JSON.stringify(["Logistics"]), track_id: "tFull" },
        { artists_json: JSON.stringify(["Logistics", "Ghost"]), track_id: "tPartial" },
        { artists_json: JSON.stringify(["Nobody"]), track_id: "tZero" },
      ],
    });
    primeCorpus();
    execute.mockResolvedValueOnce({ rowsAffected: 2 });
    execute.mockResolvedValueOnce({ rowsAffected: 3 });

    const result = await resolveArtistEdges(200, false);

    expect(result.fullyMatched).toEqual(["tFull"]);
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.zeroMatched).toEqual(["tZero"]);
    expect(result.edgesWritten).toBe(2);
    expect(result.unmatchedNames).toBe(2);
    expect(result.scanned).toBe(3);
    expect(result.nextCursor).toBeNull();

    const sqls = execute.mock.calls.map((call) => String(call[0].sql));
    expect(sqls.some((sql) => sql.includes("insert or ignore into track_artists"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("set artist_edges_backfilled_at = ?"))).toBe(true);
  });

  it("a full page returns a resume cursor (more to drain)", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { artists_json: JSON.stringify(["Logistics"]), track_id: "tA" },
        { artists_json: JSON.stringify(["Logistics"]), track_id: "tB" },
      ],
    });
    primeCorpus();
    execute.mockResolvedValue({ rows: [], rowsAffected: 1 });

    const result = await resolveArtistEdges(2, false);

    expect(result.scanned).toBe(2);
    expect(result.nextCursor).toBe("tB");
  });

  it("a dry run classifies + counts the edges it WOULD write, touching no write", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ artists_json: JSON.stringify(["Logistics", "Ghost"]), track_id: "tPartial" }],
    });
    primeCorpus();

    const result = await resolveArtistEdges(200, true);

    expect(result.dryRun).toBe(true);
    expect(result.edgesWritten).toBe(1);
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.unmatchedNames).toBe(1);

    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("an empty worklist is a clean no-op (no corpus read, no write)", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveArtistEdges(200, false);

    expect(result.scanned).toBe(0);
    expect(result.edgesWritten).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (worklist + corpus + insert + stamp)", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { artists_json: JSON.stringify(["Logistics", "Nu:Tone"]), track_id: "tA" },
        { artists_json: JSON.stringify(["Nobody"]), track_id: "tB" },
      ],
    });
    execute.mockResolvedValueOnce({
      rows: [
        { id: "art-logi", name: "Logistics" },
        { id: "art-nutone", name: "Nu:Tone" },
      ],
    });
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValue({ rows: [], rowsAffected: 2 });

    await resolveArtistEdges(200, false, "cursor-x");

    for (const [call] of execute.mock.calls as Array<[{ args?: unknown[]; sql: string }]>) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;

      expect({
        args: (call.args ?? []).length,
        placeholders,
        sql: call.sql.slice(0, 60),
      }).toMatchObject({ args: placeholders, placeholders });
    }
  });
});
