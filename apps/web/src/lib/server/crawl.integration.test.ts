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
}));

// ── The stub graph ───────────────────────────────────────────────────────────
// Med School (the seed) presses one release by Etherwood. Etherwood ALSO released on
// Hospital (an unruled label). That second release is hop 2 — in lane by graph distance,
// which is the whole gate — and its label is the one the operator must rule on next.

const LABEL_MBID = "label-medschool";
const ARTIST_MBID = "artist-etherwood";
const OTHER_ARTIST_MBID = "artist-hospital-guest";
const SEED_RELEASE = "release-seed";
const HOP2_RELEASE = "release-hop2";

function release(
  id: string,
  label: string,
  tracks: { id: string; isrc?: string; title: string }[],
) {
  return {
    "artist-credit": [{ artist: { id: ARTIST_MBID, name: "Etherwood" } }],
    "cover-art-archive": { front: true },
    date: "2013-06-10",
    id,
    "label-info": [{ label: { id: LABEL_MBID, name: label } }],
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
          release(SEED_RELEASE, "Med School", [
            { id: "rec-1", isrc: "GBCJY1300173", title: "Weightless" },
            { id: "rec-2", title: "Begin by Letting Go" },
          ]),
        );
      }

      if (url.includes(`/release/${HOP2_RELEASE}`)) {
        return json(
          release(HOP2_RELEASE, "Hospital Records", [{ id: "rec-3", title: "A Hop-2 Track" }]),
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
      "select capture_status, source_audio_key, embedding_json from tracks",
    );

    for (const row of rows.rows) {
      // The crawler acquires METADATA. It never captures audio, and the capture sweep's
      // predicate (`findings.log_id is not null`) cannot reach a row with no finding.
      expect(row.capture_status).toBe("pending");
      expect(row.source_audio_key).toBeNull();
      expect(row.embedding_json).toBeNull();
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
      "select seed_state, ruled_at from labels where slug = 'hospital-records'",
    );
    expect(label.rows[0]?.seed_state).toBe("undecided");
    // No human has ruled — which is exactly what puts it in the attention queue.
    expect(label.rows[0]?.ruled_at).toBeNull();

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

  it("never mints an ALBUM — an album is earned by a finding, not by a crawl", async () => {
    // `albums` rows come only off a CERTIFIED finding (reconcileAlbums): an album earns an
    // entity, a page and a sitemap slot because Fluncle FOUND something on it. A crawl that
    // minted them would flood the album index with every record it has merely heard of.
    await drain();

    const albums = await db.execute("select count(*) as n from albums");
    expect(Number(albums.rows[0]?.n)).toBe(0);

    // The rows still carry the release title, so the deploy backfill can link them to an
    // album that a finding later earns. Recorded, not promoted.
    const titles = await db.execute("select album from tracks where track_id like 'mb_%'");
    expect(titles.rows.every((row) => text(row.album).length > 0)).toBe(true);
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

    // The queue is DERIVED (`isrc is not null and spotify_uri is null`), so nothing had to
    // be remembered: the next tick simply picks the anchor up.
    expect((await getCrawlStatus()).anchorsPending).toBe(1); // only rec-1 carries an ISRC

    // Spotify recovers. The breaker may have started tracking the throttle; clearing it stands
    // in for the cooldown having elapsed (or an operator reset), so recovery is deterministic
    // regardless of how many passes the drain took. (The trip itself is proven precisely in
    // spotify-anchor-breaker.test.ts and the `breaker_open` integration test below.)
    await resetSpotifyAnchorBreaker();
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({
      match: {
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
    const { findSpotifyTrackByIsrc } = await import("./spotify");
    const { crawlCatalogue, getCrawlStatus } = await import("./crawl");
    const { SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } = await import("./spotify-anchor-breaker");

    // The grant is gone: every lookup answers `unauthorized` (not a throttle, not a no-match).
    // This is the OTHER silent-zero regime — before the breaker, it read identically to a
    // fully-drained queue. A run of these trips the breaker toward a pause, with a reason the
    // operator can act on (reconnect Spotify) rather than wait out a throttle that never lifts.
    vi.mocked(findSpotifyTrackByIsrc).mockResolvedValue({ rateLimited: false, unauthorized: true });
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
