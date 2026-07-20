import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The track_artists graph backfill (RFC artist-primary-capture, slice 0). The matcher is pure and
// tested directly; the PASS is tested with a mocked db.execute (no real database), which also pins
// the arity guard — every statement binds exactly its placeholders.

const execute = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));

const { buildArtistFoldMap, matchTrackNames, resolveArtistEdges } =
  await import("./backfill-artist-edges");

beforeEach(() => {
  execute.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildArtistFoldMap", () => {
  it("keys artists by their FOLDED name (case/accent/punctuation-insensitive)", () => {
    const map = buildArtistFoldMap([{ id: "art-1", name: "Nu:Tone" }], []);

    // The fold lowercases + turns punctuation into a space, so ":" becomes " " ("nu tone"), and any
    // fold-equivalent spelling resolves to the same identity.
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

describe("resolveArtistEdges", () => {
  /** Prime the two corpus reads (artists, then aliases) a wet/dry pass runs after the worklist. */
  function primeCorpus() {
    execute.mockResolvedValueOnce({ rows: [{ id: "art-logi", name: "Logistics" }] }); // loadArtists
    execute.mockResolvedValueOnce({ rows: [{ alias: "Nu Tone", artist_id: "art-nutone" }] }); // loadAliases
  }

  it("classifies a batch (full / partial / zero) and writes the matched edges", async () => {
    // 1: the worklist page (3 tracks). 2: loadArtists. 3: loadAliases. 4: insertEdges. 5: stamp.
    execute.mockResolvedValueOnce({
      rows: [
        { artists_json: JSON.stringify(["Logistics"]), track_id: "tFull" },
        { artists_json: JSON.stringify(["Logistics", "Ghost"]), track_id: "tPartial" },
        { artists_json: JSON.stringify(["Nobody"]), track_id: "tZero" },
      ],
    });
    primeCorpus();
    execute.mockResolvedValueOnce({ rowsAffected: 2 }); // insertEdges
    execute.mockResolvedValueOnce({ rowsAffected: 3 }); // stampVisited

    const result = await resolveArtistEdges(200, false);

    expect(result.fullyMatched).toEqual(["tFull"]);
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.zeroMatched).toEqual(["tZero"]);
    expect(result.edgesWritten).toBe(2); // reported from the insert's rowsAffected
    expect(result.unmatchedNames).toBe(2); // "Ghost" + "Nobody"
    expect(result.scanned).toBe(3);
    expect(result.nextCursor).toBeNull(); // 3 rows < batch limit ⇒ drained

    // The edge insert is a multi-row `insert or ignore`; the stamp updates every visited track.
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
    execute.mockResolvedValue({ rowsAffected: 1 });

    const result = await resolveArtistEdges(2, false);

    expect(result.scanned).toBe(2);
    expect(result.nextCursor).toBe("tB"); // full page ⇒ resume from the last track id
  });

  it("a dry run classifies + counts the edges it WOULD write, touching no write", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ artists_json: JSON.stringify(["Logistics", "Ghost"]), track_id: "tPartial" }],
    });
    primeCorpus();

    const result = await resolveArtistEdges(200, true);

    expect(result.dryRun).toBe(true);
    expect(result.edgesWritten).toBe(1); // the tuple it WOULD write
    expect(result.partiallyMatched).toEqual(["tPartial"]);
    expect(result.unmatchedNames).toBe(1);
    // Only the worklist + the two corpus reads ran — no insert, no stamp.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("an empty worklist is a clean no-op (no corpus read, no write)", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveArtistEdges(200, false);

    expect(result.scanned).toBe(0);
    expect(result.edgesWritten).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1); // just the worklist read
  });
});

// THE ARITY GUARD (the recording-mbids discipline). A multi-row `insert or ignore` builds its
// placeholders dynamically, so a drifted args/placeholder count could ship unseen by a mock. Every
// statement this module issues must bind exactly as many args as it declares placeholders.
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
    execute.mockResolvedValueOnce({ rows: [] }); // loadAliases
    execute.mockResolvedValue({ rowsAffected: 2 });

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
