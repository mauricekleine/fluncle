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
