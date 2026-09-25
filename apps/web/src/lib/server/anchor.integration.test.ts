import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedEmbedding, seedTrack } from "./integration-db";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;
const NOW = "2026-07-18T00:00:00.000Z";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function zeroVector(): number[] {
  return Array.from<number>({ length: DIMS }).fill(0);
}

async function embed(trackId: string): Promise<void> {
  await seedEmbedding(db, trackId, zeroVector());
}

async function seedUnanchored(row: {
  artists?: string[];
  durationMs?: number;
  isrc?: null | string;
  title?: string;
  trackId: string;
}): Promise<void> {
  const isrc = row.isrc ?? null;

  await db.execute({
    args: [
      row.trackId,
      row.title ?? "Weightless",
      JSON.stringify(row.artists ?? ["Etherwood"]),
      row.durationMs ?? 261_901,
      isrc,
      isrc?.trim() ? 1 : 0,
    ],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, has_isrc)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("anchorTrack — the exact-ISRC rung", () => {
  it("anchors on an ISRC match, stamps the attempt, and links the artists by stable id", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ artists: ["Etherwood"], isrc: "GBCJY1300173", trackId: "mb_rec-1" });

    const result = await anchorTrack("mb_rec-1", [
      {
        albumImageUrl: "https://i.scdn.co/image/cover",
        artists: [{ id: "sp-etherwood", name: "Etherwood" }],
        durationMs: 261_800,
        isrc: "gbcjy1300173",
        spotifyTrackId: "spotAnchor001",
        title: "Weightless",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "isrc" });

    const row = await db.execute(
      "select spotify_uri, spotify_url, album_image_url, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_rec-1'",
    );
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotAnchor001");
    expect(text(row.rows[0]?.spotify_url)).toBe("https://open.spotify.com/track/spotAnchor001");
    expect(text(row.rows[0]?.album_image_url)).toBe("https://i.scdn.co/image/cover");
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();

    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);

    const artist = await db.execute(
      "select id from artists where spotify_artist_id = 'sp-etherwood'",
    );
    expect(artist.rows.length).toBe(1);
    const link = await db.execute({
      args: [text(artist.rows[0]?.id)],
      sql: "select 1 from track_artists where track_id = 'mb_rec-1' and artist_id = ?",
    });
    expect(link.rows.length).toBe(1);
    expect(Number((await db.execute("select count(*) as n from findings")).rows[0]?.n)).toBe(0);
  });

  it("picks the closest duration when several candidates share the ISRC (a re-press)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ durationMs: 261_901, isrc: "GBCJY1300173", trackId: "mb_press" });

    const result = await anchorTrack("mb_press", [
      {
        artists: [],
        durationMs: 200_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: "wrong-press",
        title: "Weightless",
      },
      {
        artists: [],
        durationMs: 261_500,
        isrc: "GBCJY1300173",
        spotifyTrackId: "true-press",
        title: "Weightless",
      },
    ]);

    expect(result.verifiedBy).toBe("isrc");
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_press'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:true-press");
  });
});

describe("anchorTrack — the verified-search rung", () => {
  it("anchors a no-ISRC row via the folded artist + title + ±2s triple", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_search",
    });

    const result = await anchorTrack("mb_search", [
      {
        artists: [{ id: "sp-muffler", name: "Muffler" }],
        durationMs: 201_000,
        isrc: null,
        spotifyTrackId: "spotDribble",
        title: "Dribble",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_search'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotDribble");
  });

  it("recovers the candidate's ISRC into an ISRC-LESS row (the MusicBrainz-gap backfill)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Recover Me"],
      durationMs: 200_000,
      isrc: null,
      title: "Found It",
      trackId: "mb_recover",
    });

    const result = await anchorTrack("mb_recover", [
      {
        artists: [{ name: "Recover Me" }],
        durationMs: 200_500,
        isrc: "GB1234567890",
        spotifyTrackId: "spotFound",
        title: "Found It",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select isrc from tracks where track_id = 'mb_recover'");
    expect(text(row.rows[0]?.isrc)).toBe("GB1234567890");
  });

  it("NEVER overwrites a row's existing ISRC with the candidate's (fill-empty-only)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Keep Mine"],
      durationMs: 200_000,
      isrc: "ORIGINAL0001",
      title: "Mine",
      trackId: "mb_keep",
    });

    const result = await anchorTrack("mb_keep", [
      {
        artists: [{ name: "Keep Mine" }],
        durationMs: 200_400,
        isrc: "REPRESS00002",
        spotifyTrackId: "spotMine",
        title: "Mine",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select isrc from tracks where track_id = 'mb_keep'");
    expect(text(row.rows[0]?.isrc)).toBe("ORIGINAL0001");
  });

  it("falls through to the search rung when the row HAS an ISRC but no candidate carries it", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Artist X"],
      durationMs: 200_000,
      isrc: "COMPILATION01",
      title: "Comp Cut",
      trackId: "mb_isrc-miss",
    });

    const result = await anchorTrack("mb_isrc-miss", [
      {
        artists: [{ name: "Artist X" }],
        durationMs: 199_500,
        isrc: "OTHERISRC99",
        spotifyTrackId: "spotComp",
        title: "Comp Cut",
      },
    ]);

    expect(result.verifiedBy).toBe("search");
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_isrc-miss'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotComp");
  });
});

describe("anchorTrack — a miss stamps the attempt but writes no anchor", () => {
  it("leaves spotify_uri null and stamps spotify_anchor_attempted_at (the re-ask backoff)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_miss",
    });

    const result = await anchorTrack("mb_miss", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    expect(result).toEqual({ anchored: false, verifiedBy: null });
    const row = await db.execute(
      "select spotify_uri, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_miss'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();

    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);
  });

  it("ACCUMULATES the retry counter across attempts, so the cap can be reached", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_again",
    });
    await db.execute("update tracks set spotify_anchor_attempts = 4 where track_id = 'mb_again'");

    await anchorTrack("mb_again", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    const row = await db.execute(
      "select spotify_anchor_attempts from tracks where track_id = 'mb_again'",
    );
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(5);
  });
});

describe("anchorTrack — the rails", () => {
  it("throws not_found for an unknown track", async () => {
    const { anchorTrack, AnchorTrackError } = await import("./anchor");

    const error = await anchorTrack("nope", []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnchorTrackError);
    expect((error as { reason: string }).reason).toBe("not_found");
  });

  it("throws certified for a finding (its Spotify id is its identity, not an anchor to fill)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "spotifyCertified001" });

    await expect(anchorTrack("spotifyCertified001", [])).rejects.toMatchObject({
      reason: "certified",
    });
  });

  it("throws already_anchored when the row already carries a spotify_uri (a race)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_already" });
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:existing' where track_id = 'mb_already'",
    );

    await expect(anchorTrack("mb_already", [])).rejects.toMatchObject({
      reason: "already_anchored",
    });
  });
});

describe("requeueAnchorStamps — the operator requeue", () => {
  it("clears the stamp but NEVER the attempts cap, and only on un-anchored stamped rows", async () => {
    const { requeueAnchorStamps } = await import("./anchor");

    await seedUnanchored({ isrc: "GBCJY1300173", trackId: "mb_rq_eligible" });
    await db.execute(
      `update tracks set spotify_anchor_attempted_at = '2026-07-26T12:00:00.000Z',
        spotify_anchor_attempts = 3 where track_id = 'mb_rq_eligible'`,
    );

    await seedUnanchored({ isrc: "GBCJY1300174", trackId: "mb_rq_anchored" });
    await db.execute(
      `update tracks set spotify_uri = 'spotify:track:done',
        spotify_anchor_attempted_at = '2026-07-26T12:00:00.000Z' where track_id = 'mb_rq_anchored'`,
    );

    await seedUnanchored({ isrc: "GBCJY1300175", trackId: "mb_rq_fresh" });

    const requeued = await requeueAnchorStamps(["mb_rq_eligible", "mb_rq_anchored", "mb_rq_fresh"]);
    expect(requeued).toBe(1);

    const row = await db.execute(
      "select spotify_anchor_attempted_at as at, spotify_anchor_attempts as n from tracks where track_id = 'mb_rq_eligible'",
    );
    expect(row.rows[0]?.at).toBeNull();
    expect(Number(row.rows[0]?.n)).toBe(3);

    const anchored = await db.execute(
      "select spotify_anchor_attempted_at as at from tracks where track_id = 'mb_rq_anchored'",
    );
    expect(anchored.rows[0]?.at).not.toBeNull();

    expect(await requeueAnchorStamps(["mb_rq_eligible", "mb_rq_anchored", "mb_rq_fresh"])).toBe(0);

    expect(await requeueAnchorStamps([])).toBe(0);
  });

  it("an ISRC-less previously-attempted row's stamp SURVIVES the requeue (dead weight stays backed off)", async () => {
    const { requeueAnchorStamps } = await import("./anchor");

    await seedUnanchored({ isrc: null, trackId: "mb_rq_isrcless" });
    await db.execute(
      `update tracks set spotify_anchor_attempted_at = '2026-07-26T12:00:00.000Z',
        spotify_anchor_attempts = 2 where track_id = 'mb_rq_isrcless'`,
    );

    expect(await requeueAnchorStamps(["mb_rq_isrcless"])).toBe(0);

    const row = await db.execute(
      "select spotify_anchor_attempted_at as at, spotify_anchor_attempts as n from tracks where track_id = 'mb_rq_isrcless'",
    );
    expect(row.rows[0]?.at).toBe("2026-07-26T12:00:00.000Z");
    expect(Number(row.rows[0]?.n)).toBe(2);
  });
});

describe("requeueIsrcRecoveryStamps — the Deezer-empty window requeue", () => {
  const stampEmpty = (trackId: string, at: string) =>
    db.execute({
      args: [at, trackId],
      sql: "update tracks set isrc_recovery_attempted_at = ? where track_id = ?",
    });
  const stampRefused = (trackId: string, at: string) =>
    db.execute({
      args: [at, at, trackId],
      sql: "update tracks set isrc_recovery_attempted_at = ?, isrc_attempted_at = ? where track_id = ?",
    });

  it("clears only the Deezer-EMPTY arm inside the window, and only on still-recoverable rows", async () => {
    const { requeueIsrcRecoveryStamps } = await import("./anchor");

    await seedUnanchored({ isrc: null, trackId: "mb_ir_empty" });
    await stampEmpty("mb_ir_empty", "2026-09-10T04:00:00.000Z");

    await seedUnanchored({ isrc: null, trackId: "mb_ir_old" });
    await stampEmpty("mb_ir_old", "2026-09-01T04:00:00.000Z");

    await seedUnanchored({ isrc: null, trackId: "mb_ir_refused" });
    await stampRefused("mb_ir_refused", "2026-09-10T04:00:00.000Z");

    await seedUnanchored({ isrc: "GBCJY1300180", trackId: "mb_ir_has_isrc" });
    await stampEmpty("mb_ir_has_isrc", "2026-09-10T04:00:00.000Z");

    await seedUnanchored({ isrc: null, trackId: "mb_ir_anchored" });
    await stampEmpty("mb_ir_anchored", "2026-09-10T04:00:00.000Z");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:done' where track_id = 'mb_ir_anchored'",
    );

    const since = "2026-09-09";

    expect(await requeueIsrcRecoveryStamps({ dryRun: true, since })).toEqual({
      matched: 1,
      requeued: 0,
    });
    const untouched = await db.execute(
      "select isrc_recovery_attempted_at as at from tracks where track_id = 'mb_ir_empty'",
    );
    expect(untouched.rows[0]?.at).toBe("2026-09-10T04:00:00.000Z");

    expect(await requeueIsrcRecoveryStamps({ dryRun: false, since })).toEqual({
      matched: 1,
      requeued: 1,
    });

    const after = await db.execute(
      `select track_id, isrc_recovery_attempted_at as at from tracks
       where track_id in ('mb_ir_empty', 'mb_ir_old', 'mb_ir_refused', 'mb_ir_has_isrc', 'mb_ir_anchored')`,
    );
    expect(Object.fromEntries(after.rows.map((row) => [row.track_id, row.at]))).toEqual({
      mb_ir_anchored: "2026-09-10T04:00:00.000Z",
      mb_ir_empty: null,
      mb_ir_has_isrc: "2026-09-10T04:00:00.000Z",
      mb_ir_old: "2026-09-01T04:00:00.000Z",
      mb_ir_refused: "2026-09-10T04:00:00.000Z",
    });

    expect(await requeueIsrcRecoveryStamps({ dryRun: false, since })).toEqual({
      matched: 0,
      requeued: 0,
    });
  });

  it("never touches the anchor re-ask stamp — the ISRC-less queue head stays clear", async () => {
    const { requeueIsrcRecoveryStamps } = await import("./anchor");

    await seedUnanchored({ isrc: null, trackId: "mb_ir_anchor_stamp" });
    await stampEmpty("mb_ir_anchor_stamp", "2026-09-10T04:00:00.000Z");
    await db.execute(
      `update tracks set spotify_anchor_attempted_at = '2026-09-10T05:00:00.000Z'
       where track_id = 'mb_ir_anchor_stamp'`,
    );

    await requeueIsrcRecoveryStamps({ dryRun: false, since: "2026-09-09" });

    const row = await db.execute(
      "select spotify_anchor_attempted_at as at from tracks where track_id = 'mb_ir_anchor_stamp'",
    );
    expect(row.rows[0]?.at).toBe("2026-09-10T05:00:00.000Z");
  });
});

describe("the anchor worklist (track-work.ts kind: anchor)", () => {
  it("orders embedded rows first, then nearest_finding_score DESC, then track_id", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ title: "Embedded", trackId: "mb_c-embedded" });
    await embed("mb_c-embedded");

    await seedUnanchored({ title: "Ranked", trackId: "mb_b-ranked" });
    await db.execute(
      "update tracks set nearest_finding_score = 0.9 where track_id = 'mb_b-ranked'",
    );

    await seedUnanchored({ title: "Unranked", trackId: "mb_a-unranked" });

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual([
      "mb_c-embedded",
      "mb_b-ranked",
      "mb_a-unranked",
    ]);

    expect(work[0]?.anchorQuery).toBe("Etherwood Embedded");
  });

  it("sorts ISRC-bearing rows ahead of ISRC-less rows at equal embedding and score", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ isrc: "GBTST2600001", title: "Keyed", trackId: "mb_a-keyed" });
    await embed("mb_a-keyed");
    await seedUnanchored({ title: "Keyless", trackId: "mb_b-keyless" });
    await embed("mb_b-keyless");
    await db.execute(
      "update tracks set nearest_finding_score = 0.5 where track_id in ('mb_a-keyed', 'mb_b-keyless')",
    );

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_a-keyed", "mb_b-keyless"]);
  });

  it("puts an ISRC-bearing unembedded row ahead of an embedded ISRC-less one", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ title: "Sunk", trackId: "mb_b-sunk" });
    await embed("mb_b-sunk");
    await seedUnanchored({ isrc: "GBTST2600002", title: "Answerable", trackId: "mb_a-answerable" });

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_a-answerable", "mb_b-sunk"]);
  });

  it("sorts on the has_embedding MIRROR, not the vector itself", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ title: "Mirrored", trackId: "mb_b-mirrored" });
    await embed("mb_b-mirrored");
    await seedUnanchored({ title: "Bare", trackId: "mb_a-bare" });

    await db.execute({
      args: [JSON.stringify(zeroVector())],
      sql: `insert into track_embeddings (track_id, embedding_blob)
            values ('mb_a-bare', vector32(?))`,
    });

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_b-mirrored", "mb_a-bare"]);
  });

  it("puts the unranked tail last WITHOUT a `nulls last` clause (SQLite sorts NULL smallest)", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ title: "Unranked", trackId: "mb_z-unranked" });
    await seedUnanchored({ title: "Low", trackId: "mb_a-low" });
    await db.execute("update tracks set nearest_finding_score = 0.01 where track_id = 'mb_a-low'");

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_a-low", "mb_z-unranked"]);
  });

  it("breaks a tie on track_id DESC, so the whole clause stays one reverse index walk", async () => {
    const { listTrackWork } = await import("./track-work");

    for (const trackId of ["mb_a-tie", "mb_b-tie", "mb_c-tie"]) {
      await seedUnanchored({ title: "Tie", trackId });
      await embed(trackId);
      await db.execute("update tracks set nearest_finding_score = 0.5 where track_id = ?", [
        trackId,
      ]);
    }

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_c-tie", "mb_b-tie", "mb_a-tie"]);
  });

  it("excludes anchored, certified, dismissed, duplicate, zero-duration, and recently-attempted rows", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ trackId: "mb_ok" });

    await seedUnanchored({ trackId: "mb_anchored" });
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:x' where track_id = 'mb_anchored'",
    );

    await seedTrack(db, { logId: "001.1.1A", trackId: "spotifyFinding001" });
    await db.execute("update tracks set spotify_uri = null where track_id = 'spotifyFinding001'");

    await seedUnanchored({ trackId: "mb_dismissed" });
    await db.execute("update tracks set dismissed_at = ? where track_id = 'mb_dismissed'", [NOW]);

    await seedUnanchored({ trackId: "mb_dup" });
    await db.execute("update tracks set duplicate_of_track_id = 'x' where track_id = 'mb_dup'");

    await seedUnanchored({ durationMs: 0, trackId: "mb_nodur" });

    await seedUnanchored({ trackId: "mb_recent" });
    await db.execute(
      "update tracks set spotify_anchor_attempted_at = ? where track_id = 'mb_recent'",
      [new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()],
    );

    const work = await listTrackWork({ kind: "anchor", limit: 50 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_ok"]);
  });

  it("re-offers a row attempted longer ago than the backoff window", async () => {
    const { listTrackWork } = await import("./track-work");
    const { ANCHOR_REASK_AFTER_DAYS } = await import("./track-work");

    await seedUnanchored({ trackId: "mb_stale" });
    await db.execute(
      "update tracks set spotify_anchor_attempted_at = ? where track_id = 'mb_stale'",
      [new Date(Date.now() - (ANCHOR_REASK_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()],
    );

    const work = await listTrackWork({ kind: "anchor", limit: 50 });

    expect(work.map((item) => item.trackId)).toContain("mb_stale");
  });

  it("RETIRES a row at the retry cap and still offers the one below it", async () => {
    const { ANCHOR_MAX_ATTEMPTS, listTrackWork } = await import("./track-work");

    await seedUnanchored({ title: "Spent", trackId: "mb_capped" });
    await db.execute("update tracks set spotify_anchor_attempts = ? where track_id = 'mb_capped'", [
      ANCHOR_MAX_ATTEMPTS,
    ]);

    await seedUnanchored({ title: "One Left", trackId: "mb_nearly" });
    await db.execute("update tracks set spotify_anchor_attempts = ? where track_id = 'mb_nearly'", [
      ANCHOR_MAX_ATTEMPTS - 1,
    ]);

    await seedUnanchored({ title: "Fresh", trackId: "mb_null_attempts" });

    const work = await listTrackWork({ kind: "anchor", limit: 50 });
    const ids = work.map((item) => item.trackId);

    expect(ids).not.toContain("mb_capped");
    expect(ids).toContain("mb_nearly");
    expect(ids).toContain("mb_null_attempts");
  });

  it("excludes an UNANCHORABLE sole credit, and keeps a multi-artist credit that carries a real name", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ artists: ["Unknown Artist"], trackId: "mb_unknown" });
    await seedUnanchored({ artists: ["Various Artists"], trackId: "mb_various" });
    await seedUnanchored({ artists: ["VA"], trackId: "mb_va" });
    await seedUnanchored({ artists: ["Unknown"], trackId: "mb_bare_unknown" });
    await seedUnanchored({ artists: ["[unknown]"], trackId: "mb_bracket_unknown" });
    await seedUnanchored({ artists: ["traditional"], trackId: "mb_traditional" });

    await seedUnanchored({ artists: ["UNKNOWN ARTIST"], trackId: "mb_shouty_unknown" });

    await seedUnanchored({ artists: ["Unknown Artist", "Calibre"], trackId: "mb_with_calibre" });

    await seedUnanchored({ artists: ["Unknown Error"], trackId: "mb_real_name" });

    const work = await listTrackWork({ kind: "anchor", limit: 50 });
    const ids = work.map((item) => item.trackId);

    expect(ids.sort()).toEqual(["mb_real_name", "mb_with_calibre"]);
  });

  it("excludes a row whose label the operator ruled out, and keeps every other ruling in", async () => {
    const { countTrackWork, listTrackWork } = await import("./track-work");

    for (const [slug, state] of [
      ["ruled-out", "disabled"],
      ["in-lane", "enabled"],
      ["unruled", "undecided"],
    ] as const) {
      await db.execute({
        args: [slug, slug, slug, state],
        sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
              values (?, ?, ?, ?, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
      });
    }

    await seedUnanchored({ trackId: "mb_lbl_disabled" });
    await seedUnanchored({ trackId: "mb_lbl_enabled" });
    await seedUnanchored({ trackId: "mb_lbl_undecided" });

    await seedUnanchored({ trackId: "mb_lbl_none" });
    await db.execute("update tracks set label_id = 'ruled-out' where track_id = 'mb_lbl_disabled'");
    await db.execute("update tracks set label_id = 'in-lane' where track_id = 'mb_lbl_enabled'");
    await db.execute("update tracks set label_id = 'unruled' where track_id = 'mb_lbl_undecided'");

    const work = await listTrackWork({ kind: "anchor", limit: 50 });

    expect(work.map((item) => item.trackId).sort()).toEqual([
      "mb_lbl_enabled",
      "mb_lbl_none",
      "mb_lbl_undecided",
    ]);

    expect(await countTrackWork({ kind: "anchor" })).toBe(3);
  });

  it("the veto is a RULING, not a deletion — flipping the label back restores the row", async () => {
    const { listTrackWork } = await import("./track-work");

    await db.execute({
      args: [],
      sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
            values ('flip', 'Flip', 'flip', 'disabled', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
    });
    await seedUnanchored({ trackId: "mb_flip" });
    await db.execute("update tracks set label_id = 'flip' where track_id = 'mb_flip'");

    expect(await listTrackWork({ kind: "anchor", limit: 50 })).toEqual([]);

    await db.execute("update labels set seed_state = 'enabled' where id = 'flip'");

    expect((await listTrackWork({ kind: "anchor", limit: 50 })).map((i) => i.trackId)).toEqual([
      "mb_flip",
    ]);
  });
});

async function readReview(trackId: string) {
  const { parseAnchorReview } = await import("./anchor");
  const result = await db.execute({
    args: [trackId],
    sql: "select anchor_review_json from tracks where track_id = ?",
  });
  const raw = result.rows[0]?.anchor_review_json;

  return parseAnchorReview(typeof raw === "string" ? raw : null);
}

describe("anchorTrack — the suspected version mismatch it records on a miss", () => {
  it("records the near-match, and still refuses to anchor", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId: "mb_mismatch",
    });

    const result = await anchorTrack("mb_mismatch", [
      {
        albumImageUrl: "https://i.scdn.co/image/remix",
        artists: [{ id: "sp-calibre", name: "Calibre" }],
        durationMs: 394_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);

    expect(result).toEqual({ anchored: false, verifiedBy: null });
    const row = await db.execute(
      "select spotify_uri, spotify_anchor_attempts from tracks where track_id = 'mb_mismatch'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);

    const review = await readReview("mb_mismatch");
    expect(review?.reason).toBe("version_mismatch");
    expect(review?.title).toBe("Typical Description");
    expect(review?.candidate.title).toBe("Typical Description (Calibre Remix)");
    expect(review?.candidate.spotifyTrackId).toBe("spotRemix001");
    expect(review?.candidate.durationMs).toBe(394_000);
    expect(review?.candidate.artists).toEqual([{ id: "sp-calibre", name: "Calibre" }]);

    expect(review?.candidate.source).toBe("apify");
  });

  it("records NOTHING on a plain miss (a duration too far out, descriptors agreeing)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_plainmiss",
    });

    await anchorTrack("mb_plainmiss", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    expect(await readReview("mb_plainmiss")).toBeUndefined();
  });

  it("OVERWRITES a stale review on re-detection (the newest near-match is the one worth reading)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_rewrite",
    });

    for (const spotifyTrackId of ["spotOld", "spotNew"]) {
      await anchorTrack("mb_rewrite", [
        {
          artists: [{ name: "Calibre" }],
          durationMs: 394_000,
          spotifyTrackId,
          title: "Typical Description (Calibre Remix)",
        },
      ]);
    }

    expect((await readReview("mb_rewrite"))?.candidate.spotifyTrackId).toBe("spotNew");
  });

  it("CLEARS the review when the row later anchors (a note never outlives its miss)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId: "mb_healed",
    });

    await anchorTrack("mb_healed", [
      {
        artists: [{ name: "Calibre" }],
        durationMs: 394_000,
        spotifyTrackId: "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);
    expect(await readReview("mb_healed")).toBeDefined();

    const hit = await anchorTrack("mb_healed", [
      {
        artists: [{ name: "Calibre" }],
        durationMs: 394_200,
        spotifyTrackId: "spotPlain001",
        title: "Typical Description",
      },
    ]);

    expect(hit.anchored).toBe(true);
    expect(await readReview("mb_healed")).toBeUndefined();
  });
});

describe("listAnchorReviewRows — the attention-queue read", () => {
  async function seedReviewed(trackId: string): Promise<void> {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId,
    });
    await anchorTrack(trackId, [
      {
        artists: [{ name: "Calibre" }],
        durationMs: 394_000,
        spotifyTrackId: `spot-${trackId}`,
        title: "Typical Description (Calibre Remix)",
      },
    ]);
  }

  it("lists reviewed rows that are neither anchored nor dismissed, in track_id order", async () => {
    const { listAnchorReviewRows } = await import("./anchor");

    for (const trackId of ["mb_q2", "mb_q1", "mb_anchored", "mb_dismissed"]) {
      await seedReviewed(trackId);
    }
    await seedUnanchored({ trackId: "mb_unreviewed" });

    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:anchored' where track_id = 'mb_anchored'",
    );
    await db.execute("update tracks set dismissed_at = ? where track_id = 'mb_dismissed'", [NOW]);

    const rows = await listAnchorReviewRows();

    expect(rows.map((row) => row.trackId)).toEqual(["mb_q1", "mb_q2"]);
    expect(rows[0]?.candidateSpotifyTrackId).toBe("spot-mb_q1");
  });

  it("walks the partial review index, never the Spotify-URI index or a temp sort", async () => {
    const { anchorReviewQueueStatement } = await import("./anchor");
    const statement = anchorReviewQueueStatement();

    const plan = await db.execute({
      args: statement.args,
      sql: `explain query plan ${statement.sql}`,
    });
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");

    expect(details).toContain("tracks_anchor_review_idx");
    expect(details).not.toContain("tracks_spotify_uri_idx");
    expect(details).not.toContain("USE TEMP B-TREE");
  });
});

describe("the anchor provenance pair, persisted with the link", () => {
  async function provenance(trackId: string) {
    const row = await db.execute({
      args: [trackId],
      sql: `select spotify_anchor_source, spotify_anchor_verified_by, spotify_anchored_at
            from tracks where track_id = ?`,
    });

    return {
      anchoredAt: row.rows[0]?.spotify_anchored_at,
      source: row.rows[0]?.spotify_anchor_source,
      verifiedBy: row.rows[0]?.spotify_anchor_verified_by,
    };
  }

  it("records the RUNG and the SIGNAL on an exact-ISRC hit", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ isrc: "GBCJY1300173", trackId: "mb_prov_isrc" });
    await anchorTrack(
      "mb_prov_isrc",
      [
        {
          artists: [{ id: "sp-eth", name: "Etherwood" }],
          durationMs: 261_901,
          isrc: "GBCJY1300173",
          spotifyTrackId: "spotIsrc",
          title: "Weightless",
        },
      ],
      { source: "listenbrainz" },
    );

    const stamped = await provenance("mb_prov_isrc");

    expect(stamped.source).toBe("listenbrainz");
    expect(stamped.verifiedBy).toBe("isrc");

    expect(stamped.anchoredAt).not.toBeNull();
  });

  it("distinguishes the ±1s PROPER-SUBSET fallback from the full search triple", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_prov_full",
    });
    await anchorTrack("mb_prov_full", [
      {
        artists: [{ id: "sp-muffler", name: "Muffler" }],
        durationMs: 201_000,
        isrc: null,
        spotifyTrackId: "spotFull",
        title: "Dribble",
      },
    ]);

    await seedUnanchored({
      artists: ["LSB", "DRS"],
      durationMs: 200_000,
      isrc: null,
      title: "Could Be",
      trackId: "mb_prov_subset",
    });
    await anchorTrack("mb_prov_subset", [
      {
        artists: [{ id: "sp-lsb", name: "LSB" }],
        durationMs: 200_000,
        isrc: null,
        spotifyTrackId: "spotSubset",
        title: "Could Be",
      },
    ]);

    expect((await provenance("mb_prov_full")).verifiedBy).toBe("search");

    expect((await provenance("mb_prov_subset")).verifiedBy).toBe("search-subset");
  });

  it("leaves the pair NULL on a miss, so nothing wears provenance it did not earn", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ isrc: null, title: "Nothing Matches", trackId: "mb_prov_miss" });
    await anchorTrack("mb_prov_miss", [
      {
        artists: [{ id: "sp-other", name: "Someone Else" }],
        durationMs: 120_000,
        isrc: null,
        spotifyTrackId: "spotNope",
        title: "A Different Tune",
      },
    ]);

    expect(await provenance("mb_prov_miss")).toEqual({
      anchoredAt: null,
      source: null,
      verifiedBy: null,
    });
  });
});

describe("resolveAnchorReview — the operator's ruling", () => {
  async function seedReviewed(trackId: string, spotifyTrackId: null | string): Promise<void> {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId,
    });
    await anchorTrack(trackId, [
      {
        albumImageUrl: "https://i.scdn.co/image/remix",
        artists: [{ id: "sp-calibre", name: "Calibre" }],
        durationMs: 394_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: spotifyTrackId ?? "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);

    if (spotifyTrackId === null) {
      const review = await readReview(trackId);
      const stripped = { ...review, candidate: { ...review?.candidate, spotifyTrackId: null } };

      await db.execute({
        args: [JSON.stringify(stripped), trackId],
        sql: "update tracks set anchor_review_json = ? where track_id = ?",
      });
    }
  }

  it("accepted: writes the anchor exactly like a gate hit, links the artists, and clears the review", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_accept", "spotRemix001");

    const result = await resolveAnchorReview("mb_accept", "accepted");
    expect(result.anchored).toBe(true);

    const row = await db.execute(
      "select spotify_uri, spotify_url, album_image_url, isrc, anchor_review_json, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_accept'",
    );
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotRemix001");
    expect(text(row.rows[0]?.spotify_url)).toBe("https://open.spotify.com/track/spotRemix001");
    expect(text(row.rows[0]?.album_image_url)).toBe("https://i.scdn.co/image/remix");

    expect(text(row.rows[0]?.isrc)).toBe("GBCJY1300173");
    expect(row.rows[0]?.anchor_review_json).toBeNull();
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();

    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(2);

    const provenance = await db.execute(
      "select spotify_anchor_source, spotify_anchor_verified_by, spotify_anchored_at from tracks where track_id = 'mb_accept'",
    );
    expect(text(provenance.rows[0]?.spotify_anchor_verified_by)).toBe("operator");

    expect(provenance.rows[0]?.spotify_anchor_source).toBeNull();
    expect(provenance.rows[0]?.spotify_anchored_at).not.toBeNull();

    const artist = await db.execute(
      "select id from artists where spotify_artist_id = 'sp-calibre'",
    );
    expect(artist.rows.length).toBe(1);
    const link = await db.execute({
      args: [text(artist.rows[0]?.id)],
      sql: "select 1 from track_artists where track_id = 'mb_accept' and artist_id = ?",
    });
    expect(link.rows.length).toBe(1);

    expect(Number((await db.execute("select count(*) as n from findings")).rows[0]?.n)).toBe(0);
  });

  it("dismissed: clears the review and leaves the row un-anchored on its normal lifecycle", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_dismiss", "spotRemix001");
    const before = await db.execute(
      "select spotify_anchor_attempts from tracks where track_id = 'mb_dismiss'",
    );

    const result = await resolveAnchorReview("mb_dismiss", "dismissed");
    expect(result.anchored).toBe(false);

    const row = await db.execute(
      "select spotify_uri, anchor_review_json, spotify_anchor_attempts from tracks where track_id = 'mb_dismiss'",
    );
    expect(row.rows[0]?.anchor_review_json).toBeNull();
    expect(row.rows[0]?.spotify_uri).toBeNull();

    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(
      Number(before.rows[0]?.spotify_anchor_attempts),
    );
  });

  it("refuses to accept a candidate with no Spotify id, and keeps the review for the MB link", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_noid", null);

    await expect(resolveAnchorReview("mb_noid", "accepted")).rejects.toMatchObject({
      reason: "no_spotify_candidate",
    });

    const row = await db.execute(
      "select spotify_uri, anchor_review_json from tracks where track_id = 'mb_noid'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(row.rows[0]?.anchor_review_json).not.toBeNull();
  });

  it("throws no_review when there is nothing to rule on (a concurrent anchor cleared it)", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_noreview" });

    await expect(resolveAnchorReview("mb_noreview", "accepted")).rejects.toMatchObject({
      reason: "no_review",
    });
  });

  it("keeps the anchor rails: not_found, certified, already_anchored", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await expect(resolveAnchorReview("nope", "accepted")).rejects.toMatchObject({
      reason: "not_found",
    });

    await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "spotifyCertified002" });
    await expect(resolveAnchorReview("spotifyCertified002", "accepted")).rejects.toMatchObject({
      reason: "certified",
    });

    await seedReviewed("mb_raced", "spotRemix001");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:beat-you-to-it' where track_id = 'mb_raced'",
    );
    await expect(resolveAnchorReview("mb_raced", "accepted")).rejects.toMatchObject({
      reason: "already_anchored",
    });
  });
});

describe("listAnchorReviewRows — the attention read", () => {
  it("returns only un-anchored, non-dismissed rows carrying a review, with the evidence", async () => {
    const { anchorTrack, listAnchorReviewRows } = await import("./anchor");

    const record = async (trackId: string) => {
      await anchorTrack(trackId, [
        {
          artists: [{ id: "sp-calibre", name: "Calibre" }],
          durationMs: 394_400,
          spotifyTrackId: "spotRemix001",
          title: "Typical Description (Calibre Remix)",
        },
      ]);
    };

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_queued",
    });
    await record("mb_queued");
    await db.execute(
      "update tracks set mb_recording_id = 'mb_9f0c1234-5678-90ab-cdef-1234567890ab' where track_id = 'mb_queued'",
    );

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_anchored_review",
    });
    await record("mb_anchored_review");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:x' where track_id = 'mb_anchored_review'",
    );

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_dismissed_review",
    });
    await record("mb_dismissed_review");
    await db.execute("update tracks set dismissed_at = ? where track_id = 'mb_dismissed_review'", [
      NOW,
    ]);

    await seedUnanchored({ trackId: "mb_quiet" });

    const rows = await listAnchorReviewRows();

    expect(rows.map((row) => row.trackId)).toEqual(["mb_queued"]);
    expect(rows[0]?.title).toBe("Typical Description");
    expect(rows[0]?.artists).toEqual(["Calibre"]);
    expect(rows[0]?.candidateTitle).toBe("Typical Description (Calibre Remix)");
    expect(rows[0]?.candidateDescriptor).toBe("calibre remix");
    expect(rows[0]?.candidateArtists).toEqual(["Calibre"]);
    expect(rows[0]?.candidateSpotifyTrackId).toBe("spotRemix001");

    expect(rows[0]?.deltaMs).toBe(400);

    expect(rows[0]?.mbRecordingId).toBe("9f0c1234-5678-90ab-cdef-1234567890ab");
  });

  it("drops a row whose review JSON is unreadable (never a half-rendered queue row)", async () => {
    const { listAnchorReviewRows } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_corrupt" });
    await db.execute(
      "update tracks set anchor_review_json = '{not json' where track_id = 'mb_corrupt'",
    );

    expect(await listAnchorReviewRows()).toEqual([]);
  });
});
