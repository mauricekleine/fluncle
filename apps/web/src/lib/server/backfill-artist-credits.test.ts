import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The MB credit sweep (RFC artist-primary-capture, slice 1b). The PASS is tested with a mocked
// db.execute (no real database), a mocked MusicBrainz client (`mbFetch`), and mocked mbid WRITES
// (`mintArtistByMbid` / `adoptArtistMbid`) — so the three-rung resolve (exact mbid → ADOPT → mint),
// the homonym / different-mbid fail-closed rungs, idempotence, the no-identity terminal skip, the
// budget pause, the circuit breaker, arity, and slice-0-stamp non-interference are all pinned without
// a network or a DB. The fold map + `fold` are the REAL slice-0 matcher (pure), driven off the corpus
// the execute mock returns.

const execute = vi.fn();
const mbFetch = vi.fn();
const mintArtistByMbid = vi.fn();
const adoptArtistMbid = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./musicbrainz", () => ({ mbFetch }));
vi.mock("./artists", () => ({ adoptArtistMbid, mintArtistByMbid }));

const { resolveArtistCredits } = await import("./backfill-artist-credits");

/** A `mbFetch` resolve carrying the given artist-credits (each `{ artist: { id, name } }`). */
function credits(list: Array<{ id: string; name: string }>): {
  data: { "artist-credit": Array<{ artist: { id: string; name: string } }> };
  rateLimited: false;
} {
  return { data: { "artist-credit": list.map((a) => ({ artist: a })) }, rateLimited: false };
}

/** Queue the two per-pass corpus reads (artists corpus with mbid, then trusted aliases). */
function primeCorpus(
  artists: Array<{ id: string; mbid: string | null; name: string }>,
  aliases: Array<{ alias: string; artist_id: string }> = [],
): void {
  execute.mockResolvedValueOnce({ rows: artists }); // loadArtistCorpus
  execute.mockResolvedValueOnce({ rows: aliases }); // loadAliases
}

beforeEach(() => {
  execute.mockReset();
  mbFetch.mockReset();
  mintArtistByMbid.mockReset();
  adoptArtistMbid.mockReset();
  mintArtistByMbid.mockResolvedValue("art-minted");
  adoptArtistMbid.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveArtistCredits — the three-rung resolve", () => {
  it("MINTS when the credit matches no mbid and no existing name fold", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([]); // empty corpus ⇒ no mbid, no fold
    execute.mockResolvedValue({ rowsAffected: 1 }); // insert + stamp
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "Logistics" }]));
    mintArtistByMbid.mockResolvedValueOnce("art-new");

    const result = await resolveArtistCredits(40, false);

    expect(mintArtistByMbid).toHaveBeenCalledWith("Logistics", "mba-1");
    expect(adoptArtistMbid).not.toHaveBeenCalled();
    expect(result.mintedArtists).toBe(1);
    expect(result.adoptedArtists).toBe(0);
    expect(result.matchedArtists).toBe(0);
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-new", 1]);
  });

  it("MATCHES an existing row that already carries the exact mbid (no mint, no adopt)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([{ id: "art-x", mbid: "mba-1", name: "Whatever The Name" }]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "Renamed On MB" }]));

    const result = await resolveArtistCredits(40, false);

    expect(result.matchedArtists).toBe(1);
    expect(mintArtistByMbid).not.toHaveBeenCalled();
    expect(adoptArtistMbid).not.toHaveBeenCalled();
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-x", 1]); // the existing row, not a new mint
  });

  it("ADOPTS a Spotify-keyed row with NO mbid when the credit name folds onto it (no mint)", async () => {
    // The compound-credit case: "Sub Focus & Dimension" as one artists_json string slice 0 could not
    // match, but "Sub Focus" exists as a Spotify-keyed row with mbid still null.
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([{ id: "art-sf", mbid: null, name: "Sub Focus" }]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-sf", name: "Sub Focus" }]));

    const result = await resolveArtistCredits(40, false);

    expect(adoptArtistMbid).toHaveBeenCalledWith("art-sf", "mba-sf");
    expect(mintArtistByMbid).not.toHaveBeenCalled(); // NO duplicate row
    expect(result.adoptedArtists).toBe(1);
    expect(result.mintedArtists).toBe(0);
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-sf", 1]);
  });

  it("FAILS CLOSED to a MINT on a homonym (an ambiguous fold two distinct rows share)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    // Two distinct rows named "Nucleus" ⇒ buildArtistFoldMap drops the fold (ambiguous, fail-closed).
    primeCorpus([
      { id: "art-a", mbid: null, name: "Nucleus" },
      { id: "art-b", mbid: null, name: "Nucleus" },
    ]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-nucleus", name: "Nucleus" }]));
    mintArtistByMbid.mockResolvedValueOnce("art-fresh");

    const result = await resolveArtistCredits(40, false);

    // A homonym must never be wrongly merged — mint a fresh identity-true row instead of adopting.
    expect(adoptArtistMbid).not.toHaveBeenCalled();
    expect(mintArtistByMbid).toHaveBeenCalledWith("Nucleus", "mba-nucleus");
    expect(result.mintedArtists).toBe(1);
    expect(result.adoptedArtists).toBe(0);
  });

  it("FAILS CLOSED to a MINT when the folded row already carries a DIFFERENT mbid", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([{ id: "art-cal", mbid: "mba-old", name: "Calibre" }]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-new", name: "Calibre" }]));
    mintArtistByMbid.mockResolvedValueOnce("art-fresh");

    const result = await resolveArtistCredits(40, false);

    // The name folds onto Calibre, but that row's mbid differs ⇒ a distinct MB identity ⇒ mint, never
    // overwrite (a wrong merge is unrecoverable).
    expect(adoptArtistMbid).not.toHaveBeenCalled();
    expect(mintArtistByMbid).toHaveBeenCalledWith("Calibre", "mba-new");
    expect(result.mintedArtists).toBe(1);
  });

  it("is idempotent across the ADOPT path within a pass (adopts once, then matches the same mbid)", async () => {
    // Two tracks, each crediting the same artist by the same mbid. The first adopts; the second must
    // resolve to the SAME row via the now-populated mbid map — no second adopt, no mint.
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" },
        { mb_recording_id: "rec-2", track_id: "t2" },
      ],
    });
    primeCorpus([{ id: "art-sf", mbid: null, name: "Sub Focus" }]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValue(credits([{ id: "mba-sf", name: "Sub Focus" }]));

    const result = await resolveArtistCredits(40, false);

    expect(adoptArtistMbid).toHaveBeenCalledTimes(1); // adopted ONCE across both tracks
    expect(mintArtistByMbid).not.toHaveBeenCalled();
    expect(result.adoptedArtists).toBe(1);
    expect(result.matchedArtists).toBe(1); // t2's credit resolved by the freshly-set mbid
    // Both tracks got an edge to the same adopted row.
    const inserts = execute.mock.calls
      .filter((c) => String(c[0].sql).includes("insert or ignore"))
      .map((c) => c[0].args);
    expect(inserts).toEqual([
      ["t1", "art-sf", 1],
      ["t2", "art-sf", 1],
    ]);
  });
});

describe("resolveArtistCredits — the pass mechanics", () => {
  it("skips the Various-Artists placeholder and credits with no MB id / name", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-va", track_id: "t1" }] });
    primeCorpus([]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce({
      data: {
        "artist-credit": [
          { artist: { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" } },
          { name: "No Id Here" }, // no artist.id
          { artist: { id: "mba-real", name: "Real Artist" } },
        ],
      },
      rateLimited: false,
    });
    mintArtistByMbid.mockResolvedValueOnce("art-real");

    const result = await resolveArtistCredits(40, false);

    expect(mintArtistByMbid).toHaveBeenCalledTimes(1);
    expect(mintArtistByMbid).toHaveBeenCalledWith("Real Artist", "mba-real");
    expect(result.mintedArtists).toBe(1);
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-real", 3]); // position from the ORIGINAL credit index
  });

  it("terminally skips a zero-matched track with NO MB identity (stamped, no vendor call)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: null, track_id: "spotify-xyz" }] });
    primeCorpus([]); // resolver still built (the page is non-empty), but no credit is resolved
    execute.mockResolvedValue({ rowsAffected: 1 });

    const result = await resolveArtistCredits(40, false);

    expect(mbFetch).not.toHaveBeenCalled();
    expect(result.skippedNoIdentity).toBe(1);
    expect(result.scanned).toBe(1);
    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.filter((s) => s.includes("set artist_credits_backfilled_at = ?"))).toHaveLength(1);
  });

  it("derives the recording identity from the `mb_` PK prefix when mb_recording_id is null", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ mb_recording_id: null, track_id: "mb_rec-from-pk" }],
    });
    primeCorpus([]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));

    await resolveArtistCredits(40, false);

    expect(mbFetch).toHaveBeenCalledWith("/recording/rec-from-pk?inc=artist-credits");
  });

  it("a full page returns a resume cursor (more to drain)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));

    const result = await resolveArtistCredits(1, false); // batch limit 1, page of 1 ⇒ full

    expect(result.scanned).toBe(1);
    expect(result.nextCursor).toBe("t1");
  });

  it("stops on the MusicBrainz circuit breaker WITHOUT stamping the throttled row", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" },
        { mb_recording_id: "rec-2", track_id: "t2" },
      ],
    });
    primeCorpus([]);
    mbFetch.mockResolvedValueOnce({ data: null, rateLimited: true });

    const result = await resolveArtistCredits(40, false);

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.scanned).toBe(0);
    expect(mbFetch).toHaveBeenCalledTimes(1);
    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.some((s) => s.includes("set artist_credits_backfilled_at"))).toBe(false);
  });

  it("pauses on the 60s response budget, resuming from the last HANDLED row, tail unstamped", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" },
        { mb_recording_id: "rec-2", track_id: "t2" },
      ],
    });
    primeCorpus([]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValue(credits([{ id: "mba-1", name: "A" }]));

    // deadline = Date.now()+60000. Handle row1, then the top-of-loop check for row2 sees it spent.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000) // deadline base → 61_000
      .mockReturnValueOnce(1_000) // row1 top check: under budget
      .mockReturnValue(62_000); // row2 top check: budget spent → pause

    const result = await resolveArtistCredits(40, false);

    expect(result.scanned).toBe(1);
    expect(result.nextCursor).toBe("t1");
    expect(mbFetch).toHaveBeenCalledTimes(1);
    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.filter((s) => s.includes("set artist_credits_backfilled_at = ?"))).toHaveLength(1);

    now.mockRestore();
  });

  it("a dry run reports the eligible worklist, touching no corpus read, vendor call, or write", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" },
        { mb_recording_id: "rec-2", track_id: "t2" },
      ],
    });

    const result = await resolveArtistCredits(40, true);

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.mintedArtists).toBe(0);
    expect(result.adoptedArtists).toBe(0);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1); // just the worklist read — no corpus load
  });

  it("an empty worklist is a single-query no-op (no corpus read, idempotent re-run)", async () => {
    execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveArtistCredits(40, false);

    expect(result.scanned).toBe(0);
    expect(result.edgesWritten).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(mbFetch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("NEVER writes slice 0's stamp — its worklist READS it, its write is its OWN column", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    primeCorpus([]);
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));

    await resolveArtistCredits(40, false);

    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.some((s) => s.includes("artist_edges_backfilled_at is not null"))).toBe(true);
    expect(sqls.some((s) => s.includes("set artist_edges_backfilled_at"))).toBe(false);
  });
});

// THE ARITY GUARD (the recording-mbids discipline). A multi-row `insert or ignore` builds its
// placeholders dynamically, so a drifted args/placeholder count could ship unseen by a mock. Every
// statement this module ISSUES must bind exactly as many args as it declares placeholders (the
// adopt/mint writes live in ./artists and are mocked here, so they are guarded by that module's tests).
describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (worklist + corpus + insert + stamp + a no-identity skip)", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" }, // identity → mbFetch + insert + stamp
        { mb_recording_id: null, track_id: "spotify-2" }, // no identity → stamp only
      ],
    });
    primeCorpus([{ id: "art-sf", mbid: null, name: "Sub Focus" }]);
    execute.mockResolvedValue({ rowsAffected: 2 });
    mbFetch.mockResolvedValueOnce(
      credits([
        { id: "mba-1", name: "Sub Focus" }, // adopt
        { id: "mba-2", name: "Brand New Name" }, // mint
      ]),
    );

    await resolveArtistCredits(40, false, "cursor-x");

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
