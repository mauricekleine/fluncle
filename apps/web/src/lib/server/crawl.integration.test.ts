import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";
import { setMusicbrainzRateLimitForTests } from "./musicbrainz";

// THE CATALOGUE CRAWLER, against the REAL schema and a REAL (stubbed) MusicBrainz.
//
// The crawler's guarantees are all statements about SQL and about a graph walk, so a
// mocked database would prove none of them. These cases run the actual walk against the
// in-memory libSQL database built from the generated migrations, with MusicBrainz stubbed
// at the `fetch` boundary — so the frontier, the dedupe, the hop limit, the label mint and
// the certification firewall are exercised exactly as they run in production.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

// Spotify's ONLY job in the crawl is the by-ISRC anchor, and it runs as its own bounded
// step OUTSIDE the walk. Stub it as "not on Spotify": the walk must not depend on it, and
// a crawl in an un-authorized (or throttled) environment must still write every row.
vi.mock("./spotify", () => ({
  findSpotifyTrackByIsrc: vi.fn(() => Promise.resolve({ rateLimited: false })),
  // The search rung's helper. Default: no candidates — so the walk-only and ISRC tests never
  // stamp off a stray search, and a test that exercises the rung sets its own return.
  searchTrackCandidates: vi.fn(() => Promise.resolve([])),
}));

// ── The stub graph ───────────────────────────────────────────────────────────
// Med School (the seed) presses one release by Etherwood. Etherwood ALSO released on
// Hospital (an unruled label). That second release is hop 2 — in lane by graph distance,
// which is the whole gate — and its label is the one the operator must rule on next.

const LABEL_MBID = "label-medschool";
// Hospital carries its OWN MBID — the discovered-label fold key is real now, so two different
// labels must NOT share one MBID (that would fold them to one row). Keyed by name below.
const HOSPITAL_MBID = "label-hospital";
const LABEL_MBIDS: Record<string, string> = {
  "Hospital Records": HOSPITAL_MBID,
  "Med School": LABEL_MBID,
};
const ARTIST_MBID = "artist-etherwood";
const OTHER_ARTIST_MBID = "artist-hospital-guest";
const SEED_RELEASE = "release-seed";
const HOP2_RELEASE = "release-hop2";
const SEED_RELEASE_GROUP = "rg-medschool-sampler";
const HOP2_RELEASE_GROUP = "rg-hospital-sampler";

function release(
  id: string,
  label: string,
  releaseGroup: null | string,
  tracks: { id: string; isrc?: string; title: string }[],
) {
  return {
    "artist-credit": [{ artist: { id: ARTIST_MBID, name: "Etherwood" } }],
    "cover-art-archive": { front: true },
    date: "2013-06-10",
    id,
    "label-info": [{ label: { id: LABEL_MBIDS[label] ?? LABEL_MBID, name: label } }],
    // The album fold key MusicBrainz returns under `inc=release-groups` — a singular object.
    // Null models a release MusicBrainz has no release group for (the crawler's slug fallback).
    ...(releaseGroup ? { "release-group": { id: releaseGroup } } : {}),
    media: [
      {
        tracks: tracks.map((track) => ({
          recording: {
            "artist-credit": [
              { artist: { id: ARTIST_MBID, name: "Etherwood" } },
              // Various Artists must NEVER become a hop — it is credited on every
              // compilation ever pressed, so following it walks straight out of the genre.
              { artist: { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" } },
            ],
            id: track.id,
            isrcs: track.isrc ? [track.isrc] : [],
            length: 261901,
            title: track.title,
          },
        })),
      },
    ],
    relations: [{ type: "discogs", url: { resource: "https://www.discogs.com/release/6414598" } }],
    title: `${label} sampler`,
  };
}

/** MusicBrainz, stubbed at the fetch boundary. Every response is a real MB shape. */
function stubMusicbrainz(): void {
  vi.stubGlobal(
    "fetch",
    // `mbFetch` always calls fetch with a plain URL string, so the stub takes one.
    vi.fn((url: string) => {
      const json = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

      // The label name→MBID resolve (a free-text query; MB spells it "Med School").
      if (url.includes("/label?query=")) {
        return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
      }

      if (url.includes(`/release?label=${LABEL_MBID}`)) {
        return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
      }

      if (url.includes(`/release?artist=${ARTIST_MBID}`)) {
        return json({
          "release-count": 2,
          releases: [{ id: SEED_RELEASE }, { id: HOP2_RELEASE }],
        });
      }

      if (url.includes(`/release?artist=${OTHER_ARTIST_MBID}`)) {
        return json({ "release-count": 0, releases: [] });
      }

      if (url.includes(`/release/${SEED_RELEASE}`)) {
        return json(
          release(SEED_RELEASE, "Med School", SEED_RELEASE_GROUP, [
            { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
            { id: "rec-2", title: "Begin by Letting Go" },
          ]),
        );
      }

      if (url.includes(`/release/${HOP2_RELEASE}`)) {
        return json(
          release(HOP2_RELEASE, "Hospital Records", HOP2_RELEASE_GROUP, [
            { id: "rec-3", title: "A Hop-2 Track" },
          ]),
        );
      }

      return json({});
    }),
  );
}

/** Drain the frontier — the sweep's job, compressed into a loop. */
async function drain(maxHop = 2): Promise<{
  labelsDiscovered: string[];
  tracksSkipped: number;
  tracksWritten: number;
}> {
  const { crawlCatalogue } = await import("./crawl");
  const totals = { labelsDiscovered: [] as string[], tracksSkipped: 0, tracksWritten: 0 };

  for (let pass = 0; pass < 20; pass += 1) {
    const result = await crawlCatalogue({ limit: 10, maxHop });
    totals.tracksWritten += result.tracksWritten;
    totals.tracksSkipped += result.tracksSkipped;
    totals.labelsDiscovered.push(...result.labelsDiscovered);

    if (result.expanded === 0) {
      break;
    }
  }

  return totals;
}

const NOW = "2026-07-11T00:00:00.000Z";

/** A locale-independent string comparator (oxlint requires `sort` take one). */
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Narrow a libSQL cell to a string (its value type is a union, so `String()` won't do). */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function seedLabel(name: string, slug: string, seedState: string): Promise<void> {
  await db.execute({
    args: [`lbl_${slug}`, name, slug, seedState, NOW, NOW],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
  setMusicbrainzRateLimitForTests(0);
  stubMusicbrainz();
  // Reset the Spotify mocks to their factory defaults so a mock a prior test set (a throttle, a
  // dead grant, a match) cannot leak into the next — there is no global clearMocks here.
  const { findSpotifyTrackByIsrc, searchTrackCandidates } = await import("./spotify");
  vi.mocked(findSpotifyTrackByIsrc).mockReset();
  vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({ rateLimited: false });
  vi.mocked(searchTrackCandidates).mockReset();
  vi.mocked(searchTrackCandidates).mockResolvedValue([]);
  // The operator's ruling: Medschool is in. Nothing else is.
  await seedLabel("Medschool", "medschool", "enabled");
  await seedLabel("Anjunabeats", "anjunabeats", "disabled");
});

describe("the catalogue crawler", () => {
  it("walks label → release → artist → release and writes catalogue tracks, never findings", async () => {
    const totals = await drain();

    expect(totals.tracksWritten).toBe(3); // 2 on the seed release + 1 at hop 2

    const tracks = await db.execute("select track_id, title, label, isrc from tracks");
    expect(tracks.rows.map((row) => text(row.title)).sort(compare)).toEqual([
      "A Hop-2 Track",
      "Begin by Letting Go",
      "Weightless",
    ]);

    // THE FIREWALL. The crawler cannot certify: not one `findings` row exists.
    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(0);

    // The track_id is minted from the MB recording id — the identity that actually
    // exists for a track with no Spotify presence.
    expect(tracks.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
      "mb_rec-3",
    ]);
  });

  it("leaves every agent queue's state at its DDL default — a crawled row is nobody's work item", async () => {
    await drain();

    const rows = await db.execute(
      "select capture_status, source_audio_key, embedding_blob from tracks",
    );

    for (const row of rows.rows) {
      // The crawler acquires METADATA. It never captures audio, and the capture sweep's
      // predicate (`findings.log_id is not null`) cannot reach a row with no finding.
      expect(row.capture_status).toBe("pending");
      expect(row.source_audio_key).toBeNull();
      expect(row.embedding_blob).toBeNull();
    }
  });

  it("is IDEMPOTENT — a second crawl of the same graph writes zero new rows", async () => {
    const first = await drain();
    expect(first.tracksWritten).toBe(3);

    // Re-open the frontier: the same graph, walked again from scratch.
    await db.execute("update crawl_frontier set state = 'pending', cursor = 0");

    const second = await drain();

    expect(second.tracksWritten).toBe(0);
    expect(second.tracksSkipped).toBe(3);

    const count = await db.execute("select count(*) as n from tracks");
    expect(Number(count.rows[0]?.n)).toBe(3);
  });

  it("never mints a second row for a track Fluncle already CERTIFIED (the ISRC dedupe)", async () => {
    // The sharpest idempotence case. A finding's `track_id` is a Spotify id, so the
    // minted `mb_…` id would NOT collide — only the ISRC can recognise it. Without that
    // check the crawler would quietly shadow a finding with an uncertified twin.
    await seedTrack(db, {
      logId: "004.7.2I",
      title: "Weightless",
      trackId: "spotifyid2222222222222",
    });
    await db.execute(
      "update tracks set isrc = 'GBCJY1300173' where track_id = 'spotifyid2222222222222'",
    );

    await drain();

    const shadow = await db.execute("select track_id from tracks where isrc = 'GBCJY1300173'");
    expect(shadow.rows.map((row) => row.track_id)).toEqual(["spotifyid2222222222222"]);

    // The finding is untouched and still certified.
    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });

  it("STOPS at the hop limit — maxHop 0 never leaves the seed label's own releases", async () => {
    const totals = await drain(0);

    expect(totals.tracksWritten).toBe(2); // the seed release only; no artist hop
    const titles = await db.execute("select title from tracks");
    expect(titles.rows.map((row) => row.title)).not.toContain("A Hop-2 Track");

    // And no artist node was ever enqueued, so the walk cannot resume outward later.
    const artists = await db.execute(
      "select count(*) as n from crawl_frontier where kind = 'artist'",
    );
    expect(Number(artists.rows[0]?.n)).toBe(0);
  });

  it("mints a DISCOVERED label as `undecided` and does NOT crawl it", async () => {
    const totals = await drain();

    expect(totals.labelsDiscovered).toEqual(["Hospital Records"]);

    const label = await db.execute(
      "select seed_state, ruled_at, mb_label_id from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.seed_state).toBe("undecided");
    // No human has ruled — which is exactly what puts it in the attention queue.
    expect(label.rows[0]?.ruled_at).toBeNull();
    // The discovered label folds on its MusicBrainz MBID — stamped inline at discovery, so a
    // spelling that slugifies apart later collapses onto this row instead of duplicating.
    expect(label.rows[0]?.mb_label_id).toBe(HOSPITAL_MBID);

    // It is NOT a seed. The crawler proposes; the operator rules.
    const seeds = await db.execute(
      "select count(*) as n from crawl_frontier where source = 'fluncle'",
    );
    expect(Number(seeds.rows[0]?.n)).toBe(1); // medschool, and only medschool
  });

  it("does not re-ask the operator to rule on a label he has already ruled on, under MB's spelling", async () => {
    // The pilot found this live: he spells it "Medschool", MusicBrainz spells it
    // "Med School". A slug check would mint a second row and put it back in his queue.
    await drain();

    const rows = await db.execute("select slug from labels where slug like '%med%'");
    expect(rows.rows.map((row) => row.slug)).toEqual(["medschool"]);
  });

  it("writes the ARCHIVE's label spelling, so The Ear's capture ladder can actually fire", async () => {
    // THE CROSS-PR BUG, pinned. The Ear (docs/the-ear.md) keys every rung of the
    // capture-priority ladder — including the `skipped-label` VETO that keeps the metered
    // capture budget off a label the operator ruled OUT — on `slugify(tracks.label) =
    // labels.slug`. He spells it "Medschool"; MusicBrainz spells it "Med School", which
    // slugifies to `med-school` and matches NO label. So a crawler that wrote the vendor's
    // spelling would leave every label rung silently dead on every crawled row.
    //
    // Measured before the fix, on a real Medschool crawl: 223 rows at tier 3 (the artist
    // rung, which does not touch the label) and 512 at tier 0 — and NOTHING at tiers 1 or 2.
    await drain();

    const rows = await db.execute("select distinct label from tracks where label is not null");
    const labels = rows.rows.map((row) => text(row.label)).sort(compare);

    // "Med School" was folded back to the spelling the archive already uses.
    expect(labels).toContain("Medschool");
    expect(labels).not.toContain("Med School");

    // The invariant the whole label graph assumes: every crawled row's label slugifies onto
    // a real `labels` row. (`Hospital Records` is the DISCOVERED one — minted from MB's
    // spelling, so it agrees with its own slug by construction.)
    const { labelSlug } = await import("./labels");
    const known = await db.execute("select slug from labels");
    const slugs = new Set(known.rows.map((row) => text(row.slug)));

    for (const label of labels) {
      expect(slugs.has(labelSlug(label) ?? "")).toBe(true);
    }
  });

  it("never seeds from a label the operator disabled or has not ruled on", async () => {
    await seedLabel("UKF", "ukf", "undecided");
    await drain();

    const seeds = await db.execute(
      "select external_id from crawl_frontier where source = 'fluncle'",
    );
    expect(seeds.rows.map((row) => row.external_id)).toEqual(["medschool"]);
  });

  it("is RESUMABLE — a pass that dies leaves the frontier where the next one picks up", async () => {
    const { crawlCatalogue, getCrawlStatus } = await import("./crawl");

    // One node only: the seed resolve. Everything else must still be waiting.
    await crawlCatalogue({ limit: 1, maxHop: 2 });
    const mid = await getCrawlStatus();

    expect(mid.frontier.done).toBe(1);
    expect(mid.frontier.pending).toBe(1); // the MB label node, minted, untouched
    expect(mid.catalogueTracks).toBe(0);

    // A brand-new pass (a fresh isolate, a fresh cron tick) continues rather than restarts.
    await drain();
    const end = await getCrawlStatus();

    expect(end.catalogueTracks).toBe(3);
    expect(end.frontier.pending).toBe(0);
  });

  it("skips a seed label MusicBrainz does not know, with a reason, instead of retrying forever", async () => {
    await seedLabel("A Label MB Never Heard Of", "unknown-label", "enabled");
    await drain();

    const row = await db.execute(
      "select state, note from crawl_frontier where external_id = 'unknown-label'",
    );
    expect(row.rows[0]?.state).toBe("skipped");
    expect(row.rows[0]?.note).toBe("no exact MusicBrainz label match");
  });

  it("stops the pass on the MusicBrainz circuit breaker instead of storming it", async () => {
    const { crawlCatalogue } = await import("./crawl");

    // MB actively throttling: a 503 that survives its Retry-After retries.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 503 }))),
    );

    const result = await crawlCatalogue({ limit: 10, maxHop: 2 });

    expect(result.rateLimited).toBe(true);
    expect(result.failed).toBe(1); // it stopped after ONE failure, it did not grind ten

    // The node is backed off, not abandoned: a later tick retries it.
    const row = await db.execute("select state, failures from crawl_frontier limit 1");
    expect(row.rows[0]?.state).toBe("failed");
    expect(Number(row.rows[0]?.failures)).toBe(1);
  });

  it("stamps `label_id` so a crawled track lands on the public /label/<slug> page", async () => {
    // The graph pages (docs/label-entity.md) read `tracks.label_id` — the indexed edge, not
    // the raw string — and they show every track on a label, certified or not. The deploy
    // backfill self-heals any writer that does not know the column, this crawler included;
    // but a crawl ticks every ten minutes and a deploy does not, so the crawler stamps the
    // pointer itself and lets the backfill stay the backstop.
    await drain();

    const rows = await db.execute(`
      select tracks.track_id, labels.slug
      from tracks join labels on labels.id = tracks.label_id
      where tracks.track_id like 'mb_%'
    `);

    // All three crawled tracks are linked, and to the RIGHT label — which only works because
    // the row carries the archive's spelling (`Medschool`), not MusicBrainz's (`Med School`).
    expect(rows.rows.length).toBe(3);
    expect(new Set(rows.rows.map((row) => text(row.slug)))).toEqual(
      new Set(["medschool", "hospital-records"]),
    );
  });

  it("mints + links the ALBUM inline, folded on the release-group MBID", async () => {
    // The album edge is now written INLINE at crawl time (no deferred deploy backfill),
    // folded on MusicBrainz's release-group MBID (`inc=release-groups`). Two releases here
    // sit in two DISTINCT release groups, so the walk mints two album rows and stamps every
    // crawled track's `album_id` at the right one.
    await drain();

    const albums = await db.execute("select slug, release_group_mbid from albums order by slug");
    expect(albums.rows.map((row) => text(row.slug))).toEqual([
      "hospital-records-sampler",
      "med-school-sampler",
    ]);
    // Every album carries its fold key — the identity a re-crawl or a second pressing folds on.
    expect(new Set(albums.rows.map((row) => text(row.release_group_mbid)))).toEqual(
      new Set([SEED_RELEASE_GROUP, HOP2_RELEASE_GROUP]),
    );

    // All three crawled tracks are linked to an album (the indexed edge the /album page reads by).
    const linked = await db.execute(`
      select tracks.track_id, albums.slug
      from tracks join albums on albums.id = tracks.album_id
      where tracks.track_id like 'mb_%'
    `);
    expect(linked.rows.length).toBe(3);
    expect(new Set(linked.rows.map((row) => text(row.slug)))).toEqual(
      new Set(["hospital-records-sampler", "med-school-sampler"]),
    );

    // The raw `tracks.album` string is preserved alongside the pointer (audit trail).
    const titles = await db.execute("select album from tracks where track_id like 'mb_%'");
    expect(titles.rows.every((row) => text(row.album).length > 0)).toBe(true);
  });

  it("FALLBACK: a release with NO release group still links its album by the slug path", async () => {
    // The load-bearing fallback — nothing hard-requires the mbid. A release MusicBrainz has no
    // release group for must still land its album edge, folded on the title slug, mbid NULL.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
        }

        if (url.includes(`/release?label=${LABEL_MBID}`)) {
          return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
        }

        if (url.includes(`/release?artist=${ARTIST_MBID}`)) {
          return json({ "release-count": 1, releases: [{ id: SEED_RELEASE }] });
        }

        if (url.includes(`/release/${SEED_RELEASE}`)) {
          // No release group — MusicBrainz genuinely omits it for some releases.
          return json(
            release(SEED_RELEASE, "Med School", null, [{ id: "rec-1", title: "Weightless" }]),
          );
        }

        return json({});
      }),
    );

    await drain();

    const linked = await db.execute(`
      select albums.slug, albums.release_group_mbid
      from tracks join albums on albums.id = tracks.album_id
      where tracks.track_id = 'mb_rec-1'
    `);
    expect(text(linked.rows[0]?.slug)).toBe("med-school-sampler");
    // Linked by slug, with no fold key — exactly the null-tolerant fallback path.
    expect(linked.rows[0]?.release_group_mbid).toBeNull();
  });

  it("fills the Spotify anchor as a SEPARATE step, and a 429 costs the walk nothing", async () => {
    const { findSpotifyTrackByIsrc } = await import("./spotify");
    const { crawlCatalogue, getCrawlStatus } = await import("./crawl");
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    // Spotify is throttling — the exact failure the first live pilot hit when the lookup
    // sat inside the release write. The rows must still land; only the anchor waits.
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({ rateLimited: true });
    await drain();

    const rows = await db.execute("select count(*) as n from tracks where spotify_uri is not null");
    expect(Number(rows.rows[0]?.n)).toBe(0);
    expect((await getCrawlStatus()).catalogueTracks).toBe(3); // every row written anyway

    // The queue is DERIVED, so nothing had to be remembered: the next tick simply picks the
    // anchor up. `anchorsPending` is the ISRC-bearing gauge of that queue (the cheap partial
    // index), so it counts only rec-1 — rec-2/rec-3 have no ISRC and are drained by the search
    // rung, not this gauge.
    expect((await getCrawlStatus()).anchorsPending).toBe(1); // only rec-1 carries an ISRC

    // Spotify recovers. The breaker may have started tracking the throttle; clearing it stands
    // in for the cooldown having elapsed (or an operator reset), so recovery is deterministic
    // regardless of how many passes the drain took. (The trip itself is proven precisely in
    // spotify-anchor-breaker.test.ts and the `breaker_open` integration test below.)
    await resetSpotifyAnchorBreaker();
    // Since the search rung, the worklist also holds rec-2/rec-3 (no ISRC), so a throttle can
    // park the rotation cursor mid-way rather than on the sole ISRC row — the old wrap-in-one-pass
    // no longer holds. Clear the cursor to model the rotation returning to the top, so this single
    // recovery pass deterministically re-attempts rec-1 first. (Production fills it within a
    // rotation regardless; the cursor rotation itself is proven in the rotation describe below.)
    await db.execute("delete from settings where key = 'crawl.spotify_anchor_cursor'");
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({
      match: {
        artists: [],
        spotifyUri: "spotify:track:3QKpHwwmOUJfu53agh7UjW",
        spotifyUrl: "https://open.spotify.com/track/3QKpHwwmOUJfu53agh7UjW",
        trackId: "3QKpHwwmOUJfu53agh7UjW",
      },
      rateLimited: false,
    });
    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });

    expect(pass.anchorsFilled).toBe(1);
    expect(pass.anchorOutcome).toBe("filled");
    expect((await getCrawlStatus()).anchorsPending).toBe(0);
    // A healthy pass lifted the breaker: no lingering trip, no reason to explain.
    expect((await getCrawlStatus()).spotifyAnchor.tripped).toBe(false);

    const anchored = await db.execute("select spotify_uri from tracks where track_id = 'mb_rec-1'");
    expect(anchored.rows[0]?.spotify_uri).toBe("spotify:track:3QKpHwwmOUJfu53agh7UjW");
  });

  it("PAUSES the anchor fill (breaker_open) when Spotify's grant is gone, and surfaces it", async () => {
    const { findSpotifyTrackByIsrc, searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue, getCrawlStatus } = await import("./crawl");
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");

    // The grant is gone: every lookup answers `unauthorized` (not a throttle, not a no-match).
    // This is the OTHER silent-zero regime — before the breaker, it read identically to a
    // fully-drained queue. A run of these trips the breaker toward a pause, with a reason the
    // operator can act on (reconnect Spotify) rather than wait out a throttle that never lifts.
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({ rateLimited: false, unauthorized: true });
    // A dead grant fails BOTH rungs identically: `searchTrackCandidates` reads the token first, so
    // it THROWS the same reauth `ApiError`. Modelling only the ISRC rung would let the no-ISRC rows
    // (rec-2/rec-3) return a clean "ok" between the unauthorized passes and reset the streak.
    vi.mocked(searchTrackCandidates).mockRejectedValue(
      Object.assign(new Error("Spotify needs reconnecting"), { code: "spotify_reauth_required" }),
    );
    await drain(); // writes the rows; rec-1's anchor stays pending (nothing minted)

    // Drive exactly K failing passes so the trip is deterministic (drain's pass count is not).
    // Each pass processes the still-pending anchor, gets `unauthorized`, and folds it in until the
    // K-th trips; once tripped a pass short-circuits (`breaker_open`) and records nothing.
    for (let i = 0; i < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES; i += 1) {
      await crawlCatalogue({ limit: 10, maxHop: 2 });
    }

    const trippedStatus = await getCrawlStatus();
    expect(trippedStatus.spotifyAnchor.tripped).toBe(true);
    expect(trippedStatus.spotifyAnchor.reason).toBe("unauthorized");
    expect(trippedStatus.anchorsPending).toBe(1); // the row is still queued, nothing minted

    // While tripped the fill makes NO Spotify call — even if Spotify recovers this instant, the
    // pass short-circuits until the cooldown lapses. The mock proves the call never happened.
    vi.mocked(findSpotifyTrackByIsrc).mockClear();
    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorOutcome).toBe("breaker_open");
    expect(pass.anchorsFilled).toBe(0);
    expect(vi.mocked(findSpotifyTrackByIsrc)).not.toHaveBeenCalled();
  });

  it("reports the seed plan and writes NOTHING on a dry run", async () => {
    const { crawlCatalogue } = await import("./crawl");

    const result = await crawlCatalogue({ dryRun: true, limit: 10 });

    expect(result.dryRun).toBe(true);
    expect(result.seeded).toBe(1);

    const frontier = await db.execute("select count(*) as n from crawl_frontier");
    const tracks = await db.execute("select count(*) as n from tracks");
    expect(Number(frontier.rows[0]?.n)).toBe(0);
    expect(Number(tracks.rows[0]?.n)).toBe(0);
  });
});

describe("the Spotify anchor connects the track's artists by their stable id", () => {
  it("mints + links a crawled track's artists by their Spotify id on an ISRC anchor", async () => {
    const { findSpotifyTrackByIsrc } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    await resetSpotifyAnchorBreaker();
    // Isolate the anchor step: no enabled seed, so the walk writes nothing this pass.
    await db.execute("update labels set seed_state = 'disabled'");

    // A crawled catalogue track: an ISRC, artists on the row, and NO Spotify anchor yet.
    await db.execute({
      args: ["mb_cat-1", "Liquid Roller", `["Nu:Tone"]`, "GBTEST0000001", 270000],
      sql: `insert into tracks (track_id, title, artists_json, isrc, duration_ms)
            values (?, ?, ?, ?, ?)`,
    });

    // The ISRC lookup carries the track's Spotify artists — each with its stable id — off the SAME
    // response the anchor is read from (no extra call). The crawler connects them by that id.
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({
      match: {
        artists: [{ id: "sp-nutone", name: "Nu:Tone" }],
        spotifyUri: "spotify:track:catanchor00000000000001",
        spotifyUrl: "https://open.spotify.com/track/catanchor00000000000001",
        trackId: "catanchor00000000000001",
      },
      rateLimited: false,
    });

    await crawlCatalogue({ limit: 10, maxHop: 2 });

    // The anchor stamped …
    const anchored = await db.execute("select spotify_uri from tracks where track_id = 'mb_cat-1'");
    expect(text(anchored.rows[0]?.spotify_uri)).toBe("spotify:track:catanchor00000000000001");

    // … the artist row was MINTED, folded on the stable Spotify id …
    const artist = await db.execute("select id from artists where spotify_artist_id = 'sp-nutone'");
    expect(artist.rows.length).toBe(1);

    // … and the indexed edge links the track to it.
    const link = await db.execute({
      args: [text(artist.rows[0]?.id)],
      sql: "select 1 from track_artists where track_id = 'mb_cat-1' and artist_id = ?",
    });
    expect(link.rows.length).toBe(1);

    // THE CERTIFICATION RAIL HOLDS: minting an artist never mints a finding.
    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(0);
  });

  it("a track with no Spotify presence falls back to the name-fold and mints no artist by id", async () => {
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    await resetSpotifyAnchorBreaker();

    // Etherwood already has an entity (a certified finding minted it), carrying NO Spotify id here.
    await db.execute({
      args: ["art-etherwood", "Etherwood", "etherwood", NOW, NOW],
      sql: `insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    });

    // Drain the walk. Spotify answers "not on Spotify" for every ISRC (the default mock), so the
    // anchor's stable-id path never fires — the ONLY link a crawled track can earn is the name-fold.
    await drain();

    // The name-fold linked Etherwood's crawled tracks to the pre-existing entity …
    const linked = await db.execute({
      args: ["art-etherwood"],
      sql: `select count(*) as n from track_artists where artist_id = ?`,
    });
    expect(Number(linked.rows[0]?.n)).toBeGreaterThan(0);

    // … and NOTHING was minted by a Spotify id: the anchor path is a no-op with no Spotify presence,
    // and the name-fold mints nothing. "Various Artists" — with no entity — links nothing either.
    const minted = await db.execute(
      "select count(*) as n from artists where spotify_artist_id is not null",
    );
    expect(Number(minted.rows[0]?.n)).toBe(0);

    // Only the one pre-seeded artist exists; the crawl created no new `artists` row.
    const total = await db.execute("select count(*) as n from artists");
    expect(Number(total.rows[0]?.n)).toBe(1);
  });

  it("leaves a CERTIFIED artist's finding count untouched when a catalogue track anchors to it", async () => {
    const { findSpotifyTrackByIsrc } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");
    const { countArtistFindings } = await import("./artists");
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    await resetSpotifyAnchorBreaker();
    await db.execute("update labels set seed_state = 'disabled'");

    // A CERTIFIED artist: an entity folded on a Spotify id, a certified finding, and the edge.
    await db.execute({
      args: ["art-nutone", "sp-nutone", "Nu:Tone", "nu-tone", NOW, NOW],
      sql: `insert into artists (id, spotify_artist_id, name, slug, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)`,
    });
    await seedTrack(db, {
      artists: ["Nu:Tone"],
      logId: "001.1.1A",
      title: "Certified",
      trackId: "mb_finding-1",
    });
    await db.execute({
      args: ["mb_finding-1", "art-nutone"],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    });

    const before = await countArtistFindings("art-nutone");
    expect(before).toBe(1);

    // A NEW catalogue track anchors to the SAME artist by its stable id.
    await db.execute({
      args: ["mb_cat-3", "Roller", `["Nu:Tone"]`, "GBTEST0000003", 270000],
      sql: `insert into tracks (track_id, title, artists_json, isrc, duration_ms)
            values (?, ?, ?, ?, ?)`,
    });
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({
      match: {
        artists: [{ id: "sp-nutone", name: "Nu:Tone" }],
        spotifyUri: "spotify:track:catanchor00000000000003",
        spotifyUrl: "https://open.spotify.com/track/catanchor00000000000003",
        trackId: "catanchor00000000000003",
      },
      rateLimited: false,
    });

    await crawlCatalogue({ limit: 10, maxHop: 2 });

    // The catalogue track is now linked to the SAME artist row (folded on the stable id) …
    const links = await db.execute(
      "select count(*) as n from track_artists where artist_id = 'art-nutone'",
    );
    expect(Number(links.rows[0]?.n)).toBe(2);
    // … but the CERTIFIED finding count is unmoved: a catalogue link never counts as a finding.
    expect(await countArtistFindings("art-nutone")).toBe(before);
  });
});

describe("the Spotify anchor rotation (the keyset cursor)", () => {
  it("a head of permanent no-matches never blocks the queue — the cursor rotates past it", async () => {
    const { findSpotifyTrackByIsrc } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    await resetSpotifyAnchorBreaker();

    // 22 anchor-pending rows (ANCHOR_BUDGET is 20): the first 21 sort ahead of the
    // matchable one by track_id, and every one of them is genuinely not on Spotify.
    // Under the fixed-head scan, row 22 would NEVER be attempted.
    for (let index = 1; index <= 22; index += 1) {
      const suffix = String(index).padStart(2, "0");

      await db.execute({
        args: [
          `mb_rot-${suffix}`,
          `Rotation ${suffix}`,
          `["Rotation Artist"]`,
          `ROTISRC${suffix}`,
          270000,
        ],
        sql: `insert into tracks (track_id, title, artists_json, isrc, duration_ms)
              values (?, ?, ?, ?, ?)`,
      });
    }

    vi.mocked(findSpotifyTrackByIsrc).mockImplementation((isrc: string) =>
      Promise.resolve(
        isrc === "ROTISRC22"
          ? {
              match: {
                artists: [],
                spotifyUri: "spotify:track:rotated22",
                spotifyUrl: "https://open.spotify.com/track/rotated22",
                trackId: "rotated22",
              },
              rateLimited: false,
            }
          : { rateLimited: false },
      ),
    );

    // Pass 1 attempts rows 01-20 — all no-match, nothing filled, cursor parked at row 20.
    const first = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(first.anchorsFilled).toBe(0);
    expect(first.anchorOutcome).toBe("ok");

    // Pass 2 starts PAST the cursor — rows 21-22 — and fills the match the fixed head
    // would have ground past forever.
    const second = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(second.anchorsFilled).toBe(1);
    expect(second.anchorOutcome).toBe("filled");

    const anchored = await db.execute(
      "select spotify_uri from tracks where track_id = 'mb_rot-22'",
    );
    expect(anchored.rows[0]?.spotify_uri).toBe("spotify:track:rotated22");

    // Pass 3 finds the tail dry and WRAPS to the top — the rotation is a full loop, so a
    // no-match row is still re-asked eventually (the module's re-ask-over-checked policy).
    const third = await crawlCatalogue({ limit: 1, maxHop: 2 });
    expect(third.anchorsFilled).toBe(0);
    expect(third.anchorOutcome).toBe("ok");
  });
});

describe("the Spotify anchor search rung (verified title+artist)", () => {
  // The recall unlock: a catalogue row whose recording exists on Spotify under a DIFFERENT
  // release than the crawl walked (a compilation, a sampler) never anchors by ISRC — the ISRC
  // it carries is the compilation's, or it has none. The second rung searches by title+artist
  // and stamps ONLY on a triple-verified candidate (folded artist + folded title + duration
  // within ±2s). Isolated here by disabling the seed label: the walk writes no catalogue rows,
  // so each test's inserted rows are the only anchor-pending ones.
  const CANDIDATE = {
    artworkUrl: "https://i.scdn.co/image/searchhit",
    spotifyUrl: "https://open.spotify.com/track/spot-dribble",
  };

  async function seedAnchorRow(row: {
    artists: string[];
    durationMs: number;
    isrc?: string;
    title: string;
    trackId: string;
  }): Promise<void> {
    await db.execute({
      args: [row.trackId, row.title, JSON.stringify(row.artists), row.durationMs, row.isrc ?? null],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc)
            values (?, ?, ?, ?, ?)`,
    });
  }

  beforeEach(async () => {
    const { resetSpotifyAnchorBreaker } = await import("./spotify-anchor-breaker");

    // No enabled seed label → no walk → the only anchor-pending rows are the ones each test seeds.
    // (The module beforeEach already reset the Spotify mocks to their misses-nothing defaults.)
    await db.execute("update labels set seed_state = 'disabled'");
    await resetSpotifyAnchorBreaker();
  });

  it("anchors a no-ISRC row when a search candidate verifies (folded artist + title + duration)", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await seedAnchorRow({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_search-hit",
    });

    // Same artist + title, duration within ±2s — the recall win the ISRC rung could never reach.
    vi.mocked(searchTrackCandidates).mockResolvedValue([
      {
        artists: ["Muffler"],
        artworkUrl: CANDIDATE.artworkUrl,
        durationMs: 201_000,
        id: "spot-dribble",
        spotifyUrl: CANDIDATE.spotifyUrl,
        title: "Dribble",
      },
    ]);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(1);
    expect(pass.anchorOutcome).toBe("filled");

    const anchored = await db.execute(
      "select spotify_uri, spotify_url, album_image_url from tracks where track_id = 'mb_search-hit'",
    );
    expect(anchored.rows[0]?.spotify_uri).toBe("spotify:track:spot-dribble");
    expect(anchored.rows[0]?.spotify_url).toBe(CANDIDATE.spotifyUrl);
    expect(anchored.rows[0]?.album_image_url).toBe(CANDIDATE.artworkUrl);
  });

  it("does NOT anchor when the candidate's duration is off by more than 2s", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await seedAnchorRow({
      artists: ["Hold Tight"],
      durationMs: 200_000,
      title: "Lounge",
      trackId: "mb_dur-off",
    });

    // Right title, right artist — but 3s longer. A remaster, a different edit: not this recording.
    vi.mocked(searchTrackCandidates).mockResolvedValue([
      {
        artists: ["Hold Tight"],
        durationMs: 203_001,
        id: "spot-wrong-len",
        spotifyUrl: "https://open.spotify.com/track/spot-wrong-len",
        title: "Lounge",
      },
    ]);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(0);

    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_dur-off'");
    expect(row.rows[0]?.spotify_uri).toBeNull();
  });

  it("does NOT anchor the '- VIP' of a plain-title row (the fold keeps descriptors distinct)", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await seedAnchorRow({
      artists: ["DJ Fresh"],
      durationMs: 200_000,
      title: "Bad Company",
      trackId: "mb_vip-trap",
    });

    // The VIP is a DIFFERENT recording. Same artist, same duration, but `matchKey` carries the
    // "vip" descriptor the plain row does not — so it must never anchor to it.
    vi.mocked(searchTrackCandidates).mockResolvedValue([
      {
        artists: ["DJ Fresh"],
        durationMs: 200_000,
        id: "spot-vip",
        spotifyUrl: "https://open.spotify.com/track/spot-vip",
        title: "Bad Company - VIP",
      },
    ]);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(0);

    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_vip-trap'");
    expect(row.rows[0]?.spotify_uri).toBeNull();
  });

  it("treats a 429 from the search rung as a THROTTLE — stops the pass, advances the cursor", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await seedAnchorRow({
      artists: ["Someone"],
      durationMs: 200_000,
      title: "Throttled Track",
      trackId: "mb_throttle",
    });

    // `searchTrackCandidates` THROWS on a 429 (where the ISRC rung returns `rateLimited`); the rung
    // must read it off the error and stop the pass identically.
    vi.mocked(searchTrackCandidates).mockRejectedValue(new Error("Spotify search failed: 429"));

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorOutcome).toBe("throttled");
    expect(pass.anchorsFilled).toBe(0);

    // Cursor parity with the ISRC rung: it advanced past the attempted row, so the next tick
    // resumes rather than re-grinding the same 429.
    const cursorRow = await db.execute(
      "select value from settings where key = 'crawl.spotify_anchor_cursor'",
    );
    expect(cursorRow.rows[0]?.value).toBe("mb_throttle");

    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_throttle'");
    expect(row.rows[0]?.spotify_uri).toBeNull();
  });

  it("anchors via search when a row HAS an ISRC but the ISRC lookup misses (the rung order)", async () => {
    const { findSpotifyTrackByIsrc, searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await seedAnchorRow({
      artists: ["Artist X"],
      durationMs: 200_000,
      isrc: "FAKEISRC0001",
      title: "Compilation Cut",
      trackId: "mb_isrc-miss",
    });

    // The ISRC it carries is the compilation's — Spotify has the recording, but not under this
    // key. The ISRC rung runs FIRST and misses; the search rung then verifies and anchors.
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({ rateLimited: false });
    vi.mocked(searchTrackCandidates).mockResolvedValue([
      {
        artists: ["Artist X"],
        durationMs: 199_500,
        id: "spot-compcut",
        spotifyUrl: "https://open.spotify.com/track/spot-compcut",
        title: "Compilation Cut",
      },
    ]);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(1);
    expect(pass.anchorOutcome).toBe("filled");
    expect(vi.mocked(findSpotifyTrackByIsrc)).toHaveBeenCalledWith("FAKEISRC0001");

    const anchored = await db.execute(
      "select spotify_uri from tracks where track_id = 'mb_isrc-miss'",
    );
    expect(anchored.rows[0]?.spotify_uri).toBe("spotify:track:spot-compcut");
  });

  it("never spends a search call on a row with NO measured duration (the stored 0) — the triple is unverifiable", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    // MusicBrainz recordings can carry no length; the crawl writes those rows `duration_ms = 0`
    // (`recording.length ?? track.length ?? 0`). Such a row can NEVER clear the verification
    // triple (the duration signal is missing), so the rung must not burn one of its ten metered
    // calls on it every rotation — even when a perfect-looking candidate exists.
    await seedAnchorRow({
      artists: ["No Length"],
      durationMs: 0,
      title: "Unmeasured",
      trackId: "mb_no-duration",
    });
    vi.mocked(searchTrackCandidates).mockResolvedValue([
      {
        artists: ["No Length"],
        durationMs: 200_000,
        id: "spot-tempting",
        spotifyUrl: "https://open.spotify.com/track/spot-tempting",
        title: "Unmeasured",
      },
    ]);

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(0);
    expect(vi.mocked(searchTrackCandidates)).not.toHaveBeenCalled();

    const row = await db.execute(
      "select spotify_uri from tracks where track_id = 'mb_no-duration'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
  });
});

describe("the frontier drain — releases never starve behind a discovery wave", () => {
  it("guarantees release nodes half the batch even when older, lower-hop artist nodes crowd the head", async () => {
    const { crawlCatalogue } = await import("./crawl");

    // No seed label: the walk itself enqueues nothing; the frontier below is the whole queue.
    await db.execute("update labels set seed_state = 'disabled'");

    // THE LIVE STARVATION SHAPE (2026-07-16): a wave of hop-1 artist nodes, all OLDER
    // than the hop-2 release, so a pure `hop asc, created_at asc` drain would spend the
    // entire batch expanding artists (which write no tracks) and the catalogue flatlines.
    const old = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();

    for (let i = 0; i < 6; i += 1) {
      await db.execute({
        args: [`mb:artist:starver-${i}`, `starver-${i}`, old, old],
        sql: `insert into crawl_frontier (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
              values (?, 'artist', 'musicbrainz', ?, 1, null, 'medschool', ?, ?)`,
      });
    }
    await db.execute({
      args: [`mb:release:${SEED_RELEASE}`, SEED_RELEASE, newer, newer],
      sql: `insert into crawl_frontier (id, kind, source, external_id, hop, parent_id, label_slug, created_at, updated_at)
            values (?, 'release', 'musicbrainz', ?, 2, null, 'medschool', ?, ?)`,
    });

    // A batch smaller than the artist wave: without the split, all 4 slots go to
    // artists and tracksWritten is 0. With the split, releases get ceil(4/2) = 2
    // slots, the one pending release expands, and its tracks land.
    const pass = await crawlCatalogue({ limit: 4, maxHop: 2 });

    expect(pass.tracksWritten).toBeGreaterThan(0);

    const releaseNode = await db.execute(
      `select state from crawl_frontier where id = 'mb:release:${SEED_RELEASE}'`,
    );
    expect(releaseNode.rows[0]?.state).toBe("done");
  });
});

describe("the seed re-arm (release freshness) — an enabled label is a subscription", () => {
  // A done seed-label browse node is otherwise TERMINAL, so a label's LATER releases (a Friday
  // drop) would never surface. The re-arm flips a stale enabled label's MusicBrainz browse node
  // back to pending (cursor 0) so it re-paginates: a genuinely new release mints rows, a known
  // one is a cheap on-conflict no-op, and the two-layer idempotence folds any re-pressed track.
  const NEW_RELEASE = "release-new";
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Re-point the Med School browse at a wider release list to model a later drop. */
  function stubMedschool(releaseIds: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

        if (url.includes("/label?query=")) {
          return json({ labels: [{ id: LABEL_MBID, name: "Med School", score: 100 }] });
        }

        if (url.includes(`/release?label=${LABEL_MBID}`)) {
          return json({
            "release-count": releaseIds.length,
            releases: releaseIds.map((id) => ({ id })),
          });
        }

        if (url.includes(`/release/${SEED_RELEASE}`)) {
          return json(
            release(SEED_RELEASE, "Med School", SEED_RELEASE_GROUP, [
              { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
              { id: "rec-2", title: "Begin by Letting Go" },
            ]),
          );
        }

        // The NEWLY-pressed release: one genuinely new recording, PLUS rec-1 which the archive
        // already holds (a re-press) — the two-layer idempotence must fold the known one to a skip.
        if (url.includes(`/release/${NEW_RELEASE}`)) {
          return json(
            release(NEW_RELEASE, "Med School", "rg-new-drop", [
              { id: "rec-new", title: "Fresh Drop" },
              { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
            ]),
          );
        }

        return json({});
      }),
    );
  }

  /** Age every done MB-label browse node so it crosses the re-arm threshold. */
  async function ageSeedLabelNodes(daysAgo: number): Promise<void> {
    const old = new Date(Date.now() - daysAgo * DAY_MS).toISOString();

    await db.execute({
      args: [old],
      sql: `update crawl_frontier set done_at = ?
            where kind = 'label' and source = 'musicbrainz' and state = 'done'`,
    });
  }

  it("re-arms a stale enabled label, discovers its NEW release, and re-walks the known one for nothing", async () => {
    const { REARM_AFTER_DAYS } = await import("./crawl");
    const { crawlCatalogue } = await import("./crawl");

    // First drain (hop 0 keeps it to the seed label's own releases): rec-1 + rec-2 land.
    stubMedschool([SEED_RELEASE]);
    await drain(0);
    const before = await db.execute("select track_id from tracks");
    expect(before.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
    ]);

    // Time passes; the label drops a new release. Its done browse node is now past the threshold.
    stubMedschool([SEED_RELEASE, NEW_RELEASE]);
    await ageSeedLabelNodes(REARM_AFTER_DAYS + 1);

    // The re-arm rides this pass: it flips the MB label browse node back to pending (cursor 0).
    const rearmPass = await crawlCatalogue({ limit: 10, maxHop: 0 });
    expect(rearmPass.seedsRearmed).toBe(1);

    // Drain the rest: the re-paginated browse re-lists SEED_RELEASE (a done node → on-conflict
    // no-op, never re-walked) AND NEW_RELEASE (a fresh node → walked, mints rec-new).
    await drain(0);

    const after = await db.execute("select track_id from tracks");
    // rec-new appeared; rec-1 (on the new release, but already held) wrote nothing — the idempotence.
    expect(after.rows.map((row) => text(row.track_id)).sort(compare)).toEqual([
      "mb_rec-1",
      "mb_rec-2",
      "mb_rec-new",
    ]);

    // A re-armed subscription certifies nothing either — the firewall still holds.
    const findings = await db.execute("select count(*) as n from findings");
    expect(Number(findings.rows[0]?.n)).toBe(0);
  });

  it("does NOT re-arm a freshly-drained label (done_at < threshold)", async () => {
    const { crawlCatalogue } = await import("./crawl");

    stubMedschool([SEED_RELEASE]);
    await drain(0);

    // done_at is just now — well inside the window. No re-arm, the node stays done.
    const pass = await crawlCatalogue({ limit: 10, maxHop: 0 });
    expect(pass.seedsRearmed).toBe(0);

    const node = await db.execute(
      "select state from crawl_frontier where kind = 'label' and source = 'musicbrainz'",
    );
    expect(node.rows[0]?.state).toBe("done");
  });

  it("never re-arms a DISABLED label's done node, nor a FAILED node", async () => {
    const { REARM_AFTER_DAYS, crawlCatalogue } = await import("./crawl");

    // Silence the walk itself (nothing enabled to seed), then plant two aged nodes by hand.
    await db.execute("update labels set seed_state = 'disabled'");
    const old = new Date(Date.now() - (REARM_AFTER_DAYS + 5) * DAY_MS).toISOString();

    // A DISABLED label's done browse node, well past the threshold — re-arm is crawl SCOPE, so it
    // must stay done: a label the operator ruled OUT is not re-subscribed.
    await db.execute({
      args: ["musicbrainz:label:mb-anjuna", "mb-anjuna", old, old, old],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, done_at, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, 'anjunabeats', 'done', ?, ?, ?)`,
    });

    // A FAILED node whose label IS enabled and IS past the threshold — the exponential backoff
    // owns a failed node, so the re-arm must never disturb it.
    await db.execute("update labels set seed_state = 'enabled' where slug = 'medschool'");
    await db.execute({
      args: ["musicbrainz:label:mb-failed", "mb-failed", old, old, old],
      sql: `insert into crawl_frontier
              (id, kind, source, external_id, hop, parent_id, label_slug, state, failures, done_at, created_at, updated_at)
            values (?, 'label', 'musicbrainz', ?, 0, null, 'medschool', 'failed', 2, ?, ?, ?)`,
    });

    const pass = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(pass.seedsRearmed).toBe(0);

    const disabled = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:label:mb-anjuna'",
    );
    expect(disabled.rows[0]?.state).toBe("done");

    const failed = await db.execute(
      "select state from crawl_frontier where id = 'musicbrainz:label:mb-failed'",
    );
    expect(failed.rows[0]?.state).toBe("failed");
  });

  it("re-arms at most REARM_BATCH per pass (oldest-done-first), spreading a mass re-arm over ticks", async () => {
    const { REARM_AFTER_DAYS, REARM_BATCH, crawlCatalogue } = await import("./crawl");

    // The '88 enabled labels cross the threshold in one window' shape, shrunk to REARM_BATCH + 2.
    // Every node is a done, aged, enabled-label browse node — so all are re-arm-eligible.
    await db.execute("update labels set seed_state = 'disabled'"); // silence the seed walk
    const old = new Date(Date.now() - (REARM_AFTER_DAYS + 2) * DAY_MS).toISOString();
    const cohort = REARM_BATCH + 2;

    for (let i = 0; i < cohort; i += 1) {
      const slug = `cohort-${String(i).padStart(2, "0")}`;

      await seedLabel(`Cohort ${i}`, slug, "enabled");
      await db.execute({
        args: [`musicbrainz:label:mb-${slug}`, `mb-${slug}`, slug, old, old, old],
        sql: `insert into crawl_frontier
                (id, kind, source, external_id, hop, parent_id, label_slug, state, done_at, created_at, updated_at)
              values (?, 'label', 'musicbrainz', ?, 0, null, ?, 'done', ?, ?, ?)`,
      });
    }

    // Pass one re-arms exactly REARM_BATCH — the bound holds even though all cohort+2 are eligible.
    const first = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(first.seedsRearmed).toBe(REARM_BATCH);

    // The remaining 2 were not dropped — the next tick re-arms them (the spread), and no more.
    const second = await crawlCatalogue({ limit: 1, maxHop: 0 });
    expect(second.seedsRearmed).toBe(cohort - REARM_BATCH);
  });
});

describe("the anchor priority head — the ear's top candidates anchor first", () => {
  it("spends the head on the highest-ranked un-anchored rows and never advances the cursor off them", async () => {
    const { searchTrackCandidates } = await import("./spotify");
    const { crawlCatalogue } = await import("./crawl");

    await db.execute("update labels set seed_state = 'disabled'");

    // Two rows: a LOW track_id with no ranking (the rotation's natural first pick)
    // and a HIGH track_id carrying a top ear score. Without the priority head, the
    // rotation attempts aa_unranked first; with it, zz_top leads the pass.
    await db.execute({
      args: ["aa_unranked", "Deep Cut", JSON.stringify(["Nobody"]), 200_000],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms) values (?, ?, ?, ?)`,
    });
    await db.execute({
      args: ["zz_top-candidate", "Top Candidate", JSON.stringify(["Someone"]), 200_000, 0.97],
      sql: `insert into tracks (track_id, title, artists_json, duration_ms, nearest_finding_score)
            values (?, ?, ?, ?, ?)`,
    });

    // The search rung matches ONLY the top candidate; the unranked row misses.
    vi.mocked(searchTrackCandidates).mockImplementation((query: string) =>
      Promise.resolve(
        query.includes("Top Candidate")
          ? [
              {
                artists: ["Someone"],
                durationMs: 200_500,
                id: "spot-top",
                spotifyUrl: "https://open.spotify.com/track/spot-top",
                title: "Top Candidate",
              },
            ]
          : [],
      ),
    );

    const pass = await crawlCatalogue({ limit: 10, maxHop: 2 });
    expect(pass.anchorsFilled).toBe(1);

    const anchored = await db.execute(
      "select spotify_uri from tracks where track_id = 'zz_top-candidate'",
    );
    expect(anchored.rows[0]?.spotify_uri).toBe("spotify:track:spot-top");

    // The cursor reflects the ROTATION's last attempt (the unranked row), never the
    // priority row — the fair rotation's position survives the head.
    const cursorRow = await db.execute(
      "select value from settings where key = 'crawl.spotify_anchor_cursor'",
    );
    expect(cursorRow.rows[0]?.value).toBe("aa_unranked");
  });
});
