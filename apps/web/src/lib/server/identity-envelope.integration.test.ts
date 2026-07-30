// THE IDENTITY ENVELOPE, proven against the REAL migrated schema on an in-memory libSQL engine
// (RFC dnb-identity-graph, Unit 2 + Unit 3).
//
// It is an INTEGRATION test because every claim in the envelope is a claim about a COLUMN, and a
// mocked-DB test would pass while any of it was broken:
//
//   - THE MIGRATION ITSELF — `tracks.spotify_anchor_source` / `_verified_by` / `spotify_anchored_at`
//     and the `tracks_mb_recording_id_idx` value index. If the migration did not apply, the first
//     statement naming them throws here, which is the guard we want since `deploy:gate` runs this;
//   - EVERY STATE OFF ITS REAL COLUMNS — each `method`, each `retry` class, the `terminal: null`
//     cases, `unsupported`, and the honest negatives. These are wire claims, and a wrong one is
//     indistinguishable from a right one to anybody reading the JSON;
//   - THE SHARED REFUSAL PREDICATE — the envelope's `refused` state and the anchor worklist's own
//     exclusions run row-for-row against each other over the same fixture table. Agreement is the
//     whole reason the fragment was extracted, and it is the one property that will rot silently;
//   - THE ARRAY LOOKUPS — an ISRC or an MBID naming several rows is real SQL against real indexes,
//     and the `canonical` / `ambiguous` / `duplicate-of` verdict falls out of what comes back.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import {
  APPLE_LINKS_MACHINE_SERVED,
  IDENTITY_METHODS,
  type IdentityRecording,
  type IdentityState,
  normalizeIsrcKey,
  normalizeMbidKey,
  readIdentity,
} from "./identity-envelope";
import { spotifyHop } from "../../routes/out.spotify.$trackId";
import { anchorRefusalReason, kindClause, scopeClause } from "./track-work";
import { createIntegrationDb } from "./integration-db";

let db: Client;

/** A libSQL cell as a string, without leaning on Object's default stringification. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

/** Every `tracks` column these fixtures ever set, so one helper covers all of them. */
type TrackFixture = {
  appleAttemptedAt?: string;
  appleAttempts?: number;
  appleDoneAt?: string;
  appleUrl?: string;
  artistsJson?: string;
  discogsAttemptedAt?: string;
  discogsAttempts?: number;
  discogsDoneAt?: string;
  discogsRelease?: number;
  dismissedAt?: string;
  duplicateOf?: string;
  durationMs?: number;
  isrc?: string;
  isrcAttemptedAt?: string;
  mbAttemptedAt?: string;
  mbRecordingId?: string;
  spotifyAnchorAttempts?: number;
  spotifyAnchoredAt?: string;
  spotifyAttemptedAt?: string;
  spotifySource?: string;
  spotifyUri?: string;
  spotifyVerifiedBy?: string;
  title?: string;
};

async function insertTrack(trackId: string, fields: TrackFixture = {}): Promise<void> {
  await db.execute({
    args: [
      trackId,
      fields.title ?? "Tune",
      fields.artistsJson ?? '["Artist"]',
      fields.durationMs ?? 300_000,
      fields.isrc ?? null,
      fields.isrcAttemptedAt ?? null,
      fields.mbRecordingId ?? null,
      fields.mbAttemptedAt ?? null,
      fields.spotifyUri ?? null,
      fields.spotifyUri ? `https://open.spotify.com/track/${fields.spotifyUri.slice(14)}` : null,
      fields.spotifyAttemptedAt ?? null,
      fields.spotifyAnchorAttempts ?? null,
      fields.spotifySource ?? null,
      fields.spotifyVerifiedBy ?? null,
      fields.spotifyAnchoredAt ?? null,
      fields.appleUrl ?? null,
      fields.appleAttemptedAt ?? null,
      fields.appleAttempts ?? 0,
      fields.appleDoneAt ?? null,
      fields.discogsRelease ?? null,
      fields.discogsAttemptedAt ?? null,
      fields.discogsAttempts ?? 0,
      fields.discogsDoneAt ?? null,
      fields.dismissedAt ?? null,
      fields.duplicateOf ?? null,
    ],
    sql: `insert into tracks (
            track_id, title, artists_json, duration_ms,
            isrc, isrc_attempted_at,
            mb_recording_id, mb_recording_id_attempted_at,
            spotify_uri, spotify_url, spotify_anchor_attempted_at, spotify_anchor_attempts,
            spotify_anchor_source, spotify_anchor_verified_by, spotify_anchored_at,
            apple_music_url, backfill_apple_music_attempted_at, backfill_apple_music_attempts,
            backfill_apple_music_done_at,
            in_release_id, backfill_discogs_attempted_at, backfill_discogs_attempts,
            backfill_discogs_done_at,
            dismissed_at, duplicate_of_track_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

/** Certify a track: a `findings` row, with a Log ID unless one is withheld (the straggler case). */
async function certify(trackId: string, logId: null | string): Promise<void> {
  await db.execute({
    args: [trackId, logId],
    sql: `insert into findings (track_id, log_id, added_at)
          values (?, ?, '2026-01-01T00:00:00.000Z')`,
  });
  await db.execute({
    args: [trackId],
    sql: `update tracks set is_catalogue = 0 where track_id = ?`,
  });
}

async function only(key: Parameters<typeof readIdentity>[0]): Promise<IdentityRecording> {
  const envelope = await readIdentity(key);
  const recording = envelope?.recordings[0];

  if (!recording) {
    throw new Error("expected exactly one recording");
  }

  return recording;
}

/** Narrow to the `verified` arm so a test can read `verification` without a cast dance. */
function verificationOf(state: IdentityState) {
  if (state.state !== "verified") {
    throw new Error(`expected verified, got ${state.state}`);
  }

  return state.verification;
}

describe("the migration and the MBID value index", () => {
  it("applies the three provenance columns", async () => {
    const result = await db.execute(`select name from pragma_table_info('tracks')`);
    const names = result.rows.map((row) => text(row.name));

    expect(names).toContain("spotify_anchor_source");
    expect(names).toContain("spotify_anchor_verified_by");
    expect(names).toContain("spotify_anchored_at");
  });

  it("applies the mb_recording_id value index, and the planner uses it", async () => {
    const indexes = await db.execute(`select name from pragma_index_list('tracks')`);

    expect(indexes.rows.map((row) => text(row.name))).toContain("tracks_mb_recording_id_idx");

    // The whole reason the index exists: without it this is a full scan of a table whose rows drag
    // a 4 KB embedding blob. The plan is what proves it, not the timing.
    const plan = await db.execute(
      `explain query plan select track_id from tracks where mb_recording_id = 'x'`,
    );

    expect(plan.rows.map((row) => text(row.detail)).join(" ")).toContain(
      "tracks_mb_recording_id_idx",
    );
  });
});

describe("the Spotify state, off the persisted provenance", () => {
  it("reads each verification method the gate and the operator can write", async () => {
    const cases: Array<[string, string, string]> = [
      ["t-isrc", "isrc", "spotify-isrc"],
      ["t-search", "search", "apify"],
      ["t-subset", "search-subset", "apify"],
      ["t-lb", "isrc", "listenbrainz"],
    ];

    for (const [trackId, verifiedBy, source] of cases) {
      await insertTrack(trackId, {
        spotifyAnchoredAt: "2026-07-01T00:00:00.000Z",
        spotifySource: source,
        spotifyUri: `spotify:track:${trackId}`,
        spotifyVerifiedBy: verifiedBy,
      });

      const recording = await only({ idOrLogId: trackId, kind: "idOrLogId" });
      const verification = verificationOf(recording.links.spotify);

      expect(verification.method).toBe(verifiedBy);
      expect(verification.source).toBe(source);
      expect(verification.at).toBe("2026-07-01T00:00:00.000Z");
      // The hit time is a REAL verification time, not the last-attempt stamp beside it.
      expect(verification.atMeaning).toBe("verified");
    }
  });

  it("reads a publish-born finding as `publish`, never as legacy", async () => {
    // The best-provenance links in the archive: the operator handed over a Spotify URL and
    // Spotify's own API returned the record. Before this value existed they read `unknown-legacy`,
    // which was false about them twice over.
    await insertTrack("t-publish", {
      spotifyAnchoredAt: "2026-07-03T00:00:00.000Z",
      spotifySource: "publish",
      spotifyUri: "spotify:track:t-publish",
      spotifyVerifiedBy: "publish",
    });
    await certify("t-publish", "004.7.2I");

    const verification = verificationOf(
      (await only({ idOrLogId: "t-publish", kind: "idOrLogId" })).links.spotify,
    );

    expect(verification.method).toBe("publish");
    expect(verification.source).toBe("publish");
    // A real verification time: the moment publish wrote the row IS the moment the link was
    // verified, because the id was re-read through Spotify's own API to write it.
    expect(verification.atMeaning).toBe("verified");
    expect(verification.at).toBe("2026-07-03T00:00:00.000Z");
  });

  it("reads an operator-accepted review as `operator`, never as legacy", async () => {
    await insertTrack("t-op", {
      spotifyAnchoredAt: "2026-07-02T00:00:00.000Z",
      spotifyUri: "spotify:track:t-op",
      spotifyVerifiedBy: "operator",
    });

    const verification = verificationOf(
      (await only({ idOrLogId: "t-op", kind: "idOrLogId" })).links.spotify,
    );

    expect(verification.method).toBe("operator");
    // No rung fetched it; he did. A null source is the honest answer, not a gap.
    expect(verification.source).toBeNull();
  });

  it("reads a row anchored before the columns existed as `unknown-legacy` with a null time", async () => {
    await insertTrack("t-legacy", { spotifyUri: "spotify:track:t-legacy" });

    const verification = verificationOf(
      (await only({ idOrLogId: "t-legacy", kind: "idOrLogId" })).links.spotify,
    );

    expect(verification.method).toBe("unknown-legacy");
    expect(verification.at).toBeNull();
    // A timestamp we do not hold cannot mean anything.
    expect(verification.atMeaning).toBeNull();
  });

  it("serves the HOP, never the raw link", async () => {
    await insertTrack("t-hop", { spotifyUri: "spotify:track:abc123" });

    const spotify = (await only({ idOrLogId: "t-hop", kind: "idOrLogId" })).links.spotify;

    expect(spotify.state === "verified" && spotify.url).toBe(
      "https://www.fluncle.com/out/spotify/t-hop",
    );
    // Keyed on Fluncle's id. A Spotify id in that path would BE the mapping.
    expect(spotify.state === "verified" && spotify.url).not.toContain("abc123");
    expect(spotify.state === "verified" && spotify.value).toBe("abc123");
  });

  it("says `absent` with a cap and no attempt count when a look missed", async () => {
    await insertTrack("t-missed", {
      spotifyAnchorAttempts: 2,
      spotifyAttemptedAt: "2026-07-01T00:00:00.000Z",
    });

    const spotify = (await only({ idOrLogId: "t-missed", kind: "idOrLogId" })).links.spotify;

    expect(spotify).toEqual({
      cap: 6,
      lastAttemptedAt: "2026-07-01T00:00:00.000Z",
      retry: "capped",
      state: "absent",
      terminal: false,
    });
    // NEVER the requeue-decremented budget counter: it is a spend allowance, not a tally.
    expect(spotify).not.toHaveProperty("attempts");
  });

  it("says `unattempted` when nobody has looked", async () => {
    await insertTrack("t-fresh");

    expect((await only({ idOrLogId: "t-fresh", kind: "idOrLogId" })).links.spotify).toEqual({
      state: "unattempted",
    });
  });
});

describe("the `refused` state agrees with the anchor worklist, row for row", () => {
  it("names each of the five permanent exclusions", async () => {
    const cases: Array<[string, string, TrackFixture]> = [
      ["r-cap", "attempt-cap-reached", { spotifyAnchorAttempts: 6 }],
      ["r-credit", "credit-not-an-identity", { artistsJson: '["Unknown Artist"]' }],
      ["r-dismissed", "dismissed", { dismissedAt: "2026-07-01T00:00:00.000Z" }],
      ["r-duplicate", "duplicate", { duplicateOf: "some-other" }],
      ["r-duration", "no-duration", { durationMs: 0 }],
    ];

    for (const [trackId, reason, fields] of cases) {
      await insertTrack(trackId, fields);

      expect((await only({ idOrLogId: trackId, kind: "idOrLogId" })).links.spotify).toEqual({
        reason,
        state: "refused",
      });
    }
  });

  it("refuses rather than reporting `absent` when a look already happened", async () => {
    // The cap is reached AND the row was attempted. "We stopped looking" is the more useful of the
    // two true answers, so `refused` wins the ordering.
    await insertTrack("r-both", {
      spotifyAnchorAttempts: 6,
      spotifyAttemptedAt: "2026-07-01T00:00:00.000Z",
    });

    expect((await only({ idOrLogId: "r-both", kind: "idOrLogId" })).links.spotify).toEqual({
      reason: "attempt-cap-reached",
      state: "refused",
    });
  });

  it("matches the worklist's own SQL exclusions over the whole fixture table", async () => {
    // THE LOCKSTEP PROOF. Two independent implementations of the same five conditions — the SQL
    // fragment `kindClause("anchor")` composes, and the TypeScript `anchorRefusalReason` the
    // envelope calls — must partition the same rows the same way. Anything else means the wire is
    // claiming something the queue does not do.
    const fixtures: Array<[string, TrackFixture]> = [
      ["a-eligible", {}],
      ["a-cap", { spotifyAnchorAttempts: 6 }],
      ["a-just-under-cap", { spotifyAnchorAttempts: 5 }],
      ["a-credit", { artistsJson: '["Various Artists"]' }],
      ["a-credit-mixed", { artistsJson: '["Unknown Artist","Calibre"]' }],
      ["a-dismissed", { dismissedAt: "2026-07-01T00:00:00.000Z" }],
      ["a-duplicate", { duplicateOf: "a-eligible" }],
      ["a-no-duration", { durationMs: 0 }],
      ["a-backed-off", { spotifyAttemptedAt: new Date().toISOString() }],
    ];

    for (const [trackId, fields] of fixtures) {
      await insertTrack(trackId, fields);
    }

    // The worklist's own predicate, run as SQL with the un-anchored + catalogue scope it always
    // carries. Everything it EXCLUDES is either refused or merely backed off; nothing it INCLUDES
    // may be refused.
    const where = kindClause("anchor");
    const offered = await db.execute({
      args: where.args,
      sql: `select t.track_id from tracks t left join findings f on f.track_id = t.track_id
            where ${scopeClause("catalogue")} and ${where.sql}`,
    });
    const offeredIds = new Set(offered.rows.map((row) => text(row.track_id)));

    const rows = await db.execute(
      `select track_id, artists_json, dismissed_at, duration_ms, duplicate_of_track_id,
              spotify_anchor_attempts
       from tracks order by track_id`,
    );

    for (const row of rows.rows) {
      const trackId = text(row.track_id);
      const refusal = anchorRefusalReason({
        artistsJson: row.artists_json as null | string,
        dismissedAt: row.dismissed_at as null | string,
        duplicateOfTrackId: row.duplicate_of_track_id as null | string,
        durationMs: row.duration_ms as null | number,
        spotifyAnchorAttempts: row.spotify_anchor_attempts as null | number,
      });

      if (refusal) {
        expect(offeredIds.has(trackId), `${trackId} is refused but the worklist offers it`).toBe(
          false,
        );
      }
    }

    // And the converse, which is the half that catches an over-eager refusal: every row the
    // worklist DOES offer must read as not-refused.
    for (const trackId of offeredIds) {
      const recording = await only({ idOrLogId: trackId, kind: "idOrLogId" });

      expect(recording.links.spotify.state, `${trackId} is offered but reads refused`).not.toBe(
        "refused",
      );
    }

    // The backed-off row proves the temporal condition is NOT in the shared fragment: the worklist
    // holds it back for a fortnight, and the envelope still says "we looked", never "we refuse".
    expect(offeredIds.has("a-backed-off")).toBe(false);
    expect((await only({ idOrLogId: "a-backed-off", kind: "idOrLogId" })).links.spotify.state).toBe(
      "absent",
    );
  });
});

describe("the identifiers and the other platforms", () => {
  it("reads the MusicBrainz id as pk-derived on a crawler-born row", async () => {
    const mbid = "b9a1e6f0-1c2d-4e3f-8a5b-6c7d8e9f0a1b";

    await insertTrack(`mb_${mbid}`, {
      mbAttemptedAt: "2026-05-01T00:00:00.000Z",
      mbRecordingId: mbid,
    });

    const state = (await only({ idOrLogId: `mb_${mbid}`, kind: "idOrLogId" })).identifiers
      .mbRecordingId;
    const verification = verificationOf(state);

    expect(verification.method).toBe("pk-derived");
    // The stamp is a LAST-ATTEMPT time, and the envelope says so rather than dressing it up.
    expect(verification.atMeaning).toBe("attempted");
    expect(state.state === "verified" && state.url).toBe(
      `https://musicbrainz.org/recording/${mbid}`,
    );
  });

  it("reads a missed MusicBrainz look as single-shot and terminal", async () => {
    await insertTrack("mb-missed", { mbAttemptedAt: "2026-05-01T00:00:00.000Z" });

    expect(
      (await only({ idOrLogId: "mb-missed", kind: "idOrLogId" })).identifiers.mbRecordingId,
    ).toEqual({
      cap: null,
      lastAttemptedAt: "2026-05-01T00:00:00.000Z",
      retry: "single-shot",
      state: "absent",
      terminal: true,
    });
  });

  it("reads a missed ISRC look as recheckable with an UNKNOWN terminal", async () => {
    await insertTrack("isrc-missed", { isrcAttemptedAt: "2026-05-01T00:00:00.000Z" });

    expect((await only({ idOrLogId: "isrc-missed", kind: "idOrLogId" })).identifiers.isrc).toEqual({
      cap: null,
      lastAttemptedAt: "2026-05-01T00:00:00.000Z",
      retry: "recheckable",
      state: "absent",
      // No column anywhere says "stop asking for this row's ISRC", so neither does the envelope.
      terminal: null,
    });
  });

  it("splits the Discogs retry class by tier, and never claims a terminal either way", async () => {
    await insertTrack("dg-catalogue", {
      discogsAttemptedAt: "2026-05-01T00:00:00.000Z",
      discogsAttempts: 1,
    });
    await insertTrack("dg-certified", {
      discogsAttemptedAt: "2026-05-01T00:00:00.000Z",
      discogsAttempts: 1,
    });
    await certify("dg-certified", "004.7.2I");

    // Only the per-finding sweep revisits a Discogs look, and it cannot reach a row with no
    // findings row — so an uncertified recording's mint-time look is the only one it will get.
    expect((await only({ idOrLogId: "dg-catalogue", kind: "idOrLogId" })).links.discogs).toEqual({
      attempts: 1,
      cap: null,
      lastAttemptedAt: "2026-05-01T00:00:00.000Z",
      retry: "single-shot",
      state: "absent",
      terminal: null,
    });

    expect((await only({ idOrLogId: "dg-certified", kind: "idOrLogId" })).links.discogs).toEqual({
      attempts: 1,
      cap: null,
      lastAttemptedAt: "2026-05-01T00:00:00.000Z",
      retry: "recheckable",
      state: "absent",
      terminal: null,
    });
  });

  it("serves the Discogs release link with the moment it resolved", async () => {
    await insertTrack("dg-hit", {
      discogsAttemptedAt: "2026-05-01T00:00:00.000Z",
      discogsDoneAt: "2026-05-01T00:00:00.000Z",
      discogsRelease: 12_345,
    });

    const state = (await only({ idOrLogId: "dg-hit", kind: "idOrLogId" })).links.discogs;

    expect(state.state === "verified" && state.url).toBe("https://www.discogs.com/release/12345");
    expect(verificationOf(state).atMeaning).toBe("verified");
  });

  it("serves Apple Music unsupported to a machine, and Tidal and Deezer to everyone", async () => {
    // Apple: ADPLA §3.3.6(D) (MusicKit) does not permit serving these links to a third party, read
    // verbatim 2026-07-29. Deezer: Fluncle holds no Deezer link at all. Tidal: no integration.
    // A row carrying a real Apple link still reads `unsupported`, which is the point of the gate.
    await insertTrack("ap-held", {
      appleDoneAt: "2026-05-01T00:00:00.000Z",
      appleUrl: "https://music.apple.com/us/album/x/1?i=2",
    });

    const links = (await only({ idOrLogId: "ap-held", kind: "idOrLogId" })).links;

    expect(APPLE_LINKS_MACHINE_SERVED).toBe(false);
    expect(links.appleMusic).toEqual({ state: "unsupported" });
    expect(links.deezer).toEqual({ state: "unsupported" });
    expect(links.tidal).toEqual({ state: "unsupported" });
  });

  // ── THE AUDIENCE SPLIT ──────────────────────────────────────────────────────────────────────
  // One row, two readers, and Apple is the ONLY field they may disagree about. The clause bars
  // handing the link to a third party (the `machine` read), not rendering it on Fluncle's own page
  // (the `first-party` read, which is what `/log` has always done). A regression in either
  // direction is silent — an over-serving API breaks a licence, an under-serving page hides a link
  // Fluncle is free to show — so both halves are pinned here against the SAME fixture row.
  it("shows the page an Apple link it withholds from the API, and nothing else differs", async () => {
    await insertTrack("ap-split", {
      appleDoneAt: "2026-05-01T00:00:00.000Z",
      appleUrl: "https://music.apple.com/us/album/x/1?i=2",
      isrc: "GBABC1234567",
    });

    const key = { idOrLogId: "ap-split", kind: "idOrLogId" } as const;
    const machine = (await readIdentity(key))?.recordings[0];
    const page = (await readIdentity(key, "first-party"))?.recordings[0];

    expect(machine?.links.appleMusic).toEqual({ state: "unsupported" });
    expect(page?.links.appleMusic).toEqual({
      state: "verified",
      url: "https://music.apple.com/us/album/x/1?i=2",
      value: "https://music.apple.com/us/album/x/1?i=2",
      verification: {
        at: "2026-05-01T00:00:00.000Z",
        atMeaning: "verified",
        method: "isrc",
        source: null,
      },
    });
    // Everything else is one answer. Two readers who disagreed about more than Apple's licence
    // would make the "page and API cannot answer differently" claim a lie.
    expect({ ...page, links: undefined }).toEqual({ ...machine, links: undefined });
    expect({ ...page?.links, appleMusic: undefined }).toEqual({
      ...machine?.links,
      appleMusic: undefined,
    });
  });

  it("says the page's honest Apple negative rather than hiding the look behind the gate", async () => {
    await insertTrack("ap-missed", {
      appleAttemptedAt: "2026-06-02T00:00:00.000Z",
      appleAttempts: 2,
    });

    const key = { idOrLogId: "ap-missed", kind: "idOrLogId" } as const;

    expect((await readIdentity(key, "first-party"))?.recordings[0]?.links.appleMusic).toEqual({
      attempts: 2,
      cap: null,
      lastAttemptedAt: "2026-06-02T00:00:00.000Z",
      retry: "recheckable",
      state: "absent",
      terminal: false,
    });
    expect((await readIdentity(key))?.recordings[0]?.links.appleMusic).toEqual({
      state: "unsupported",
    });
  });
});

describe("tier, and the straggler window", () => {
  it("carries `certified` and `logId` separately, never inferring one from the other", async () => {
    await insertTrack("c-full");
    await certify("c-full", "004.7.2I");

    await insertTrack("c-straggler");
    // A findings row with no coordinate yet: mid-publish, and not certified until it has both.
    await certify("c-straggler", null);

    await insertTrack("c-uncertified");

    const full = await only({ idOrLogId: "c-full", kind: "idOrLogId" });
    const straggler = await only({ idOrLogId: "c-straggler", kind: "idOrLogId" });
    const uncertified = await only({ idOrLogId: "c-uncertified", kind: "idOrLogId" });

    expect([full.certified, full.logId]).toEqual([true, "004.7.2I"]);
    expect([straggler.certified, straggler.logId]).toEqual([false, null]);
    expect([uncertified.certified, uncertified.logId]).toEqual([false, null]);
  });

  it("serves an uncertified recording the same shape, with no Fluncle-authored word in it", async () => {
    await insertTrack("u-1", { isrc: "GBABC1234567" });

    const recording = await only({ idOrLogId: "u-1", kind: "idOrLogId" });
    const serialized = JSON.stringify(recording);

    expect(recording.certified).toBe(false);
    expect(recording.logId).toBeNull();
    expect(recording).not.toHaveProperty("note");
    // The tier lives in ONE boolean. No field name, enum value, or reason string may name it.
    for (const noun of ["finding", "catalogue", "uncertified", "banger"]) {
      expect(serialized.toLowerCase()).not.toContain(noun);
    }
  });

  it("resolves a Log ID as well as a track id", async () => {
    await insertTrack("c-by-log");
    await certify("c-by-log", "010.1.1A");

    expect((await only({ idOrLogId: "010.1.1A", kind: "idOrLogId" })).trackId).toBe("c-by-log");
  });
});

describe("the key lookups and the relation between what they return", () => {
  it("answers a single match as canonical", async () => {
    await insertTrack("k-1", { isrc: "GBABC1234567" });

    const envelope = await readIdentity({ isrc: "GBABC1234567", kind: "isrc" });

    expect(envelope?.recordings).toHaveLength(1);
    expect(envelope?.recordings[0]?.relation).toBe("canonical");
    expect(envelope?.meta.contact).toBe("hey@fluncle.com");
    expect(envelope?.meta.attribution).toContain("MusicBrainz");
  });

  it("answers a shared ISRC as an array, marking every unruled row ambiguous", async () => {
    await insertTrack("k-a", { isrc: "GBABC1234567" });
    await insertTrack("k-b", { isrc: "GBABC1234567" });

    const envelope = await readIdentity({ isrc: "GBABC1234567", kind: "isrc" });

    expect(envelope?.recordings.map((row) => row.trackId)).toEqual(["k-a", "k-b"]);
    // Nobody has ruled between them, and the envelope says exactly that rather than picking.
    expect(envelope?.recordings.map((row) => row.relation)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("names what a ruled duplicate duplicates, and leaves the survivor canonical", async () => {
    await insertTrack("k-canon", { isrc: "GBABC1234567" });
    await insertTrack("k-dupe", { duplicateOf: "k-canon", isrc: "GBABC1234567" });

    const envelope = await readIdentity({ isrc: "GBABC1234567", kind: "isrc" });
    const byId = new Map(envelope?.recordings.map((row) => [row.trackId, row.relation]));

    expect(byId.get("k-dupe")).toBe("duplicate-of:k-canon");
    expect(byId.get("k-canon")).toBe("canonical");
  });

  it("answers an MBID lookup off real SQL, array and all", async () => {
    const mbid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    await insertTrack(`mb_${mbid}`, { mbRecordingId: mbid });
    await insertTrack("spotify-born", { mbRecordingId: mbid });

    const envelope = await readIdentity({ kind: "mbid", mbid });

    expect(envelope?.recordings).toHaveLength(2);
    // The same recording reached by two birth paths, neither ruled: ambiguous, not a silent pick.
    expect(envelope?.recordings.every((row) => row.relation === "ambiguous")).toBe(true);
  });

  it("returns undefined for a key that matches nothing", async () => {
    expect(await readIdentity({ isrc: "GBZZZ9999999", kind: "isrc" })).toBeUndefined();
    expect(
      await readIdentity({ kind: "mbid", mbid: "11111111-2222-3333-4444-555555555555" }),
    ).toBeUndefined();
    expect(await readIdentity({ idOrLogId: "nope", kind: "idOrLogId" })).toBeUndefined();
  });
});

describe("the method enum is closed, and closed the SAME way on both sides", () => {
  it("matches the contract's enum exactly, member for member", async () => {
    // The one guard that stops the two definitions drifting. The server computes a `method` and the
    // contract validates it, so a value added to one alone is either an unusable enum member or a
    // response that fails its own schema at runtime — and neither shows up until a caller hits the
    // exact row that produces it.
    const { IdentityMethodSchema } = await import("@fluncle/contracts/orpc");

    expect([...IdentityMethodSchema.options].sort()).toEqual([...IDENTITY_METHODS].sort());
  });

  it("carries no tier noun in any member", () => {
    // The tier lives in the `certified` boolean and nowhere else, enum values included.
    for (const method of IDENTITY_METHODS) {
      for (const noun of ["finding", "catalogue", "banger", "uncertified"]) {
        expect(method).not.toContain(noun);
      }
    }
  });
});

describe("the key formats", () => {
  it("accepts an ISRC however a human spelled it, and rejects a non-ISRC", () => {
    expect(normalizeIsrcKey("gb-abc-12-34567")).toBe("GBABC1234567");
    expect(normalizeIsrcKey(" GBABC1234567 ")).toBe("GBABC1234567");
    expect(normalizeIsrcKey("not-an-isrc")).toBeUndefined();
    expect(normalizeIsrcKey("GBABC123456")).toBeUndefined();
  });

  it("accepts a MusicBrainz UUID with or without the row-id prefix, and rejects the rest", () => {
    const mbid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    expect(normalizeMbidKey(mbid.toUpperCase())).toBe(mbid);
    expect(normalizeMbidKey(`mb_${mbid}`)).toBe(mbid);
    expect(normalizeMbidKey("aaaaaaaa-bbbb-cccc-dddd")).toBeUndefined();
  });
});

describe("the Spotify hop", () => {
  it("302s to the stored raw link", async () => {
    await insertTrack("h-1", { spotifyUri: "spotify:track:abc123" });

    const response = await spotifyHop("h-1");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://open.spotify.com/track/abc123");
  });

  it("404s on an unknown id and on a row with no anchor", async () => {
    await insertTrack("h-bare");

    expect((await spotifyHop("h-bare")).status).toBe(404);
    expect((await spotifyHop("h-nope")).status).toBe(404);
  });
});
