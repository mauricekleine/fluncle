import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The MB credit sweep (RFC artist-primary-capture, slice 1b). The PASS is tested with a mocked
// db.execute (no real database), a mocked MusicBrainz client (`mbFetch`), and a mocked mbid mint
// (`ensureArtistByMbid`) — so mint-vs-match, the no-identity terminal skip, the budget pause, the
// circuit breaker, arity, and slice-0-stamp non-interference are all pinned without a network or a DB.

const execute = vi.fn();
const mbFetch = vi.fn();
const ensureArtistByMbid = vi.fn();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");

  return { ...actual, getDb: async () => ({ execute }) };
});

vi.mock("./log", () => ({ logEvent: vi.fn() }));
vi.mock("./musicbrainz", () => ({ mbFetch }));
vi.mock("./artists", () => ({ ensureArtistByMbid }));

const { resolveArtistCredits } = await import("./backfill-artist-credits");

/** A `mbFetch` resolve carrying the given artist-credits (each `{ artist: { id, name } }`). */
function credits(list: Array<{ id: string; name: string }>): {
  data: { "artist-credit": Array<{ artist: { id: string; name: string } }> };
  rateLimited: false;
} {
  return { data: { "artist-credit": list.map((a) => ({ artist: a })) }, rateLimited: false };
}

beforeEach(() => {
  execute.mockReset();
  mbFetch.mockReset();
  ensureArtistByMbid.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveArtistCredits", () => {
  it("mints one artist, matches another, writes the edges, and stamps the row", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ mb_recording_id: "rec-1", track_id: "t1" }],
    });
    execute.mockResolvedValue({ rowsAffected: 2 }); // insertEdges + stampVisited
    mbFetch.mockResolvedValueOnce(
      credits([
        { id: "mba-1", name: "Logistics" },
        { id: "mba-2", name: "Nu:Tone" },
      ]),
    );
    ensureArtistByMbid
      .mockResolvedValueOnce({ artistId: "art-1", minted: true }) // mba-1 → minted
      .mockResolvedValueOnce({ artistId: "art-2", minted: false }); // mba-2 → matched

    const result = await resolveArtistCredits(40, false);

    expect(mbFetch).toHaveBeenCalledWith("/recording/rec-1?inc=artist-credits");
    expect(result.mintedArtists).toBe(1);
    expect(result.matchedArtists).toBe(1);
    expect(result.edgesWritten).toBe(2); // from the insert's rowsAffected
    expect(result.scanned).toBe(1);
    expect(result.skippedNoIdentity).toBe(0);
    expect(result.nextCursor).toBeNull(); // 1 row < batch limit ⇒ drained

    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.some((s) => s.includes("insert or ignore into track_artists"))).toBe(true);
    expect(sqls.some((s) => s.includes("set artist_credits_backfilled_at = ?"))).toBe(true);
    // The edge carries the credit ORDER as position (1-based).
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-1", 1, "t1", "art-2", 2]);
  });

  it("skips the Various-Artists placeholder and credits with no MB id (no edge for either)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-va", track_id: "t1" }] });
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
    ensureArtistByMbid.mockResolvedValueOnce({ artistId: "art-real", minted: true });

    const result = await resolveArtistCredits(40, false);

    // Only the one real credit resolved; VA + the id-less credit were skipped.
    expect(ensureArtistByMbid).toHaveBeenCalledTimes(1);
    expect(ensureArtistByMbid).toHaveBeenCalledWith("Real Artist", "mba-real");
    expect(result.mintedArtists).toBe(1);
    const insert = execute.mock.calls.find((c) => String(c[0].sql).includes("insert or ignore"));
    expect(insert?.[0].args).toEqual(["t1", "art-real", 3]); // position from the ORIGINAL credit index
  });

  it("terminally skips a zero-matched track with NO MB identity (stamped, no vendor call)", async () => {
    // mb_recording_id null AND a non-`mb_` track id ⇒ no identity to resolve.
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: null, track_id: "spotify-xyz" }] });
    execute.mockResolvedValue({ rowsAffected: 1 });

    const result = await resolveArtistCredits(40, false);

    expect(mbFetch).not.toHaveBeenCalled();
    expect(result.skippedNoIdentity).toBe(1);
    expect(result.scanned).toBe(1);
    // It WAS stamped so it drains (the terminal-skip contract).
    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.filter((s) => s.includes("set artist_credits_backfilled_at = ?"))).toHaveLength(1);
  });

  it("derives the recording identity from the `mb_` PK prefix when mb_recording_id is null", async () => {
    execute.mockResolvedValueOnce({
      rows: [{ mb_recording_id: null, track_id: "mb_rec-from-pk" }],
    });
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));
    ensureArtistByMbid.mockResolvedValueOnce({ artistId: "art-1", minted: true });

    await resolveArtistCredits(40, false);

    expect(mbFetch).toHaveBeenCalledWith("/recording/rec-from-pk?inc=artist-credits");
  });

  it("a full page returns a resume cursor (more to drain)", async () => {
    execute.mockResolvedValueOnce({ rows: [{ mb_recording_id: "rec-1", track_id: "t1" }] });
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));
    ensureArtistByMbid.mockResolvedValueOnce({ artistId: "art-1", minted: true });

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
    mbFetch.mockResolvedValueOnce({ data: null, rateLimited: true });

    const result = await resolveArtistCredits(40, false);

    expect(result.rateLimited).toBe(true);
    expect(result.nextCursor).toBeNull(); // throttle-stop nulls the cursor
    expect(result.scanned).toBe(0);
    expect(mbFetch).toHaveBeenCalledTimes(1); // stopped after the first throttle
    // Nothing was stamped — only the worklist read ran.
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
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValue(credits([{ id: "mba-1", name: "A" }]));
    ensureArtistByMbid.mockResolvedValue({ artistId: "art-1", minted: true });

    // deadline = Date.now()+60000. Handle row1, then the top-of-loop check for row2 sees the budget spent.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000) // deadline base → 61_000
      .mockReturnValueOnce(1_000) // row1 top check: under budget
      .mockReturnValue(62_000); // row2 top check: budget spent → pause

    const result = await resolveArtistCredits(40, false);

    expect(result.scanned).toBe(1); // only row1 handled
    expect(result.nextCursor).toBe("t1"); // resume right after the last HANDLED row
    // row2 was NOT visited: mbFetch fired once, exactly one stamp landed.
    expect(mbFetch).toHaveBeenCalledTimes(1);
    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    expect(sqls.filter((s) => s.includes("set artist_credits_backfilled_at = ?"))).toHaveLength(1);

    now.mockRestore();
  });

  it("a dry run reports the eligible worklist, touching no vendor call or write", async () => {
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
    expect(result.edgesWritten).toBe(0);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1); // just the worklist read
  });

  it("an empty worklist is a clean no-op (idempotent re-run over drained history)", async () => {
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
    execute.mockResolvedValue({ rowsAffected: 1 });
    mbFetch.mockResolvedValueOnce(credits([{ id: "mba-1", name: "A" }]));
    ensureArtistByMbid.mockResolvedValueOnce({ artistId: "art-1", minted: true });

    await resolveArtistCredits(40, false);

    const sqls = execute.mock.calls.map((c) => String(c[0].sql));
    // The worklist READS the slice-0 stamp (gate), but nothing SETS it.
    expect(sqls.some((s) => s.includes("artist_edges_backfilled_at is not null"))).toBe(true);
    expect(sqls.some((s) => s.includes("set artist_edges_backfilled_at"))).toBe(false);
  });
});

// THE ARITY GUARD (the recording-mbids discipline). A multi-row `insert or ignore` builds its
// placeholders dynamically, so a drifted args/placeholder count could ship unseen by a mock. Every
// statement this module issues must bind exactly as many args as it declares placeholders.
describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (worklist + insert + stamp + a no-identity skip)", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        { mb_recording_id: "rec-1", track_id: "t1" }, // identity → mbFetch + insert + stamp
        { mb_recording_id: null, track_id: "spotify-2" }, // no identity → stamp only
      ],
    });
    execute.mockResolvedValue({ rowsAffected: 2 });
    mbFetch.mockResolvedValueOnce(
      credits([
        { id: "mba-1", name: "A" },
        { id: "mba-2", name: "B" },
      ]),
    );
    ensureArtistByMbid
      .mockResolvedValueOnce({ artistId: "art-1", minted: true })
      .mockResolvedValueOnce({ artistId: "art-2", minted: false });

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
