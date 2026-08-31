// The synthetic E2E seed — a small, deterministic, COMMITTED dataset.
//
// Everyday local dev seeds its DB from a PROD SNAPSHOT (`.dev/seed.sql`,
// gitignored). This repo is public and CI has no snapshot, so the e2e stack seeds
// a fresh empty DB with these fixtures instead: real generated migrations
// (applied by `db:migrate` before this runs) + this handful of rows. Everything
// here is invented — no real artists, no prod IDs, no external media URLs.
//
// It REUSES the `integration-db.ts` seed factories (the same ones the vitest
// integration suite uses), so the fixture shapes can never drift from the schema.
// Media fields are left null: no fixture points at the prod CDN, so every seeded
// page renders with zero external fetches.

import { createClient, type Client } from "@libsql/client";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import {
  seedAlbum,
  seedArtist,
  seedCatalogueTrack,
  seedLabel,
  seedMixtape,
  seedTrack,
} from "../../src/lib/server/integration-db";
import { LIBSQL_URL } from "./stack";

// One graph entity of each kind, so the `/artist`, `/label`, `/album`, and
// `/mixtapes` pages a follow-up spec exercises have a real row to resolve.
const ARTIST = { id: "e2e-artist-nova", name: "Nova Kestrel", slug: "nova-kestrel" };
const LABEL = { id: "e2e-label-driftwave", name: "Driftwave Audio", slug: "driftwave-audio" };
const ALBUM = { id: "e2e-album-signal", name: "Signal Bloom", slug: "signal-bloom" };

// Eight findings with distinct titles, artists, and Log IDs. The titles are the
// pilot spec's assertion targets, so they are intentionally unmistakable strings
// no real archive would carry. `addedAt` descends so the newest-first feed order
// is deterministic (FINDING_LOG_ID_PATTERN: `\d{3,4}\.\d\.\d[A-Z]`).
type FindingFixture = { artist: string; logId: string; title: string };

const FINDINGS: FindingFixture[] = [
  { artist: "Nova Kestrel", logId: "701.1.0A", title: "Synthetic Aurora" },
  { artist: "Cobalt Mirage", logId: "702.2.0B", title: "Neon Undertow" },
  { artist: "Halcyon Drift", logId: "703.3.0C", title: "Glassbottom Reverie" },
  { artist: "Pulsewidth", logId: "704.4.0D", title: "Cathode Sunrise" },
  { artist: "Marrow & Vane", logId: "705.5.0E", title: "Velvet Static" },
  { artist: "Sable Lung", logId: "706.6.0F", title: "Paper Lantern Riot" },
  { artist: "Quiet Cartel", logId: "707.7.0G", title: "Ferrite Bloom" },
  { artist: "Ostrich Ballet", logId: "708.8.0H", title: "Tungsten Lullaby" },
];

const MIXTAPE = { id: "e2e-mixtape-1", logId: "700.F.1A", title: "Dream Sector One" };

/** The seeded finding titles, exported so the spec asserts on identity, not counts. */
export const SEEDED_FINDING_TITLES = FINDINGS.map((finding) => finding.title);
export const SEEDED_MIXTAPE_TITLE = MIXTAPE.title;

// ── APPENDED (account journey) ────────────────────────────────────────────────
// The account journey (tests/e2e/account.spec.ts) saves ONE finding and then looks
// for it on `/account?tab=saves`, so it needs that finding's Log ID as well as its
// title. It uses the FIRST fixture — the one wired into the full artist ↔ label ↔
// album graph above — so the page it saves from is the richest one seeded. Derived
// from `FINDINGS`, never re-typed, so the two can never disagree.
export const SEEDED_SAVE_TARGET_LOG_ID = FINDINGS[0]?.logId ?? "";
export const SEEDED_SAVE_TARGET_TITLE = FINDINGS[0]?.title ?? "";

// ── APPENDED: the reader/graph specs' identity handles ──────────────────────────────
// Derived from the fixtures above, never a second description of them. The `/log` and graph
// specs assert on identity (a coordinate, a slug, a name), so they need the values the base
// fixtures already carry — not new rows. Nothing here changes what is seeded.

/** The seeded finding coordinates, in feed order (index 0 is the newest). */
export const SEEDED_FINDING_LOG_IDS = FINDINGS.map((finding) => finding.logId);

/**
 * The one finding wired into the FULL graph (artist ↔ label ↔ album) by `seedE2eData` below.
 * Its `/log/<logId>` page is the reader spec's subject, and every graph page resolves through it.
 */
export const SEEDED_GRAPH_FINDING = {
  artist: FINDINGS[0]?.artist ?? "",
  logId: FINDINGS[0]?.logId ?? "",
  title: FINDINGS[0]?.title ?? "",
};

/** The seeded graph entities — the `/artist`, `/label`, and `/album` pages' identities. */
export const SEEDED_GRAPH_ENTITIES = {
  album: { name: ALBUM.name, slug: ALBUM.slug },
  artist: { name: ARTIST.name, slug: ARTIST.slug },
  label: { name: LABEL.name, slug: LABEL.slug },
};

/** A base epoch for the descending `added_at` values (fixed, so runs are identical). */
const BASE_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

// ── APPENDED: the RADIO fixture (radio.spec.ts) ──────────────────────────────
//
// `/radio` plays only a RADIO-ELIGIBLE finding, and eligibility is a real
// predicate on `findings` (tracks.ts `getRadioEligibleTracks`): a clean square
// master (`video_squared_at`), an observation (`observation_audio_url`), its
// length (`observation_duration_ms` — the audio IS the schedule clock), and a
// Log ID. None of the eight findings above carries any of that, so the eligible
// set would be EMPTY and the surface would only ever speak its quiet-sector copy.
// This is the one finding that satisfies the predicate.
//
// It is a SEPARATE row rather than an upgrade of an existing fixture, so the
// eight above (and the specs asserting on them) are untouched.
//
// The observation URL points at the same absolute media host the product derives
// its video crops from; `blockExternalRequests` stubs both, so the surface still
// makes zero live requests — radio's entry gate opens on its own bounded timer
// when the media cannot start, which is exactly the state the spec drives.
const RADIO_FINDING = {
  artist: "Lantern Wick",
  logId: "709.9.0J",
  observationAudioUrl: "https://found.fluncle.com/709.9.0J/observation.mp3",
  // Ten minutes: far longer than any spec run, so the shared schedule cannot roll
  // to another segment mid-assertion. With one eligible finding the loop is this
  // finding, forever, and `nextTrack` is (correctly) omitted as self-referential.
  observationDurationMs: 600_000,
  title: "Salt Marsh Signal",
  trackId: "e2e-track-radio",
} as const;

/** The one radio-eligible seeded finding — the only thing `/radio` can ever resolve to. */
export const SEEDED_RADIO_FINDING = {
  artist: RADIO_FINDING.artist,
  logId: RADIO_FINDING.logId,
  title: RADIO_FINDING.title,
};

// ── APPENDED: the FRONT DOOR's fixtures (front-door.spec.ts) ─────────────────
//
// The front door (`/`) renders four bands the eight base findings alone cannot fill honestly:
//
//   - the EDITED LEAD is the newest finding carrying a NOTE, so at least one fixture has to
//     carry one — otherwise the loader's fallback path is the only one a browser ever exercises;
//   - the RELEASE band reads `tracks.release_date` inside a trailing window, and no base fixture
//     has a release date at all, so the band would only ever speak its empty state;
//   - that band carries BOTH registers, so it needs one UNCERTIFIED row (a `tracks` row with no
//     `findings` row) to prove the unlit half renders unlit, coordinate-free, and unnamed;
//   - the LEAD's cover is the page's LCP element, so one fixture needs an `album_image_url` for
//     the preload/eager contract and the failed-cover fallback to be observable at all.
//
// All of it is stamped onto rows that already exist (plus the one catalogue row), so the base
// eight and every spec asserting on them are untouched.

/** The lead's note — asserted verbatim, so the spec proves the EDITED placement, not just a slot. */
export const SEEDED_LEAD_NOTE =
  "Came down through a green sector and the air went thick before I clocked the coordinate.";

/** The finding the front door leads with: the one carrying a note (never the newest by date). */
export const SEEDED_LEAD = {
  artist: FINDINGS[1]?.artist ?? "",
  logId: FINDINGS[1]?.logId ?? "",
  title: FINDINGS[1]?.title ?? "",
  trackId: "e2e-track-2",
};

/**
 * The lead's cover, pointed at the absolute prod media host. `blockExternalRequests` stubs it with
 * a real 1×1 PNG, so the happy path renders an `<img>`; the failed-cover spec overrides that one
 * route with a 404 to drive `TrackArtwork`'s fallback. A relative URL could not do either job.
 */
export const SEEDED_LEAD_COVER_URL = "https://found.fluncle.com/e2e/lead-cover.jpg";

/**
 * Two NON-lead findings that also carry cover art. Without them every tile in the findings band
 * would render the coverless fallback, and the "one eager image, everything else lazy" contract
 * would have nothing to measure — the assertion would pass vacuously on an empty set.
 */
export const SEEDED_COVERED_FINDINGS = [
  { coverUrl: "https://found.fluncle.com/e2e/cover-3.jpg", trackId: "e2e-track-3" },
  { coverUrl: "https://found.fluncle.com/e2e/cover-4.jpg", trackId: "e2e-track-4" },
] as const;

/**
 * The one finding carrying FOOTAGE (`findings.video_url`), which is the whole gate on the Stories
 * affordance: `TrackRow` renders its artwork as a play link only when a row has video, and the
 * `/findings` cover ring opens at the newest finding that does. Without a row here both paths fall
 * back to a plain cover and a `/log` link, so the Stories route is dark in every spec — it is the
 * one part of the incumbent archive page that has no coverage until this fixture exists.
 *
 * It rides `e2e-track-3`, which already carries cover art, so the play glyph sits over a real
 * `<img>` rather than the coverless fallback.
 */
export const SEEDED_STORY_FINDING = {
  logId: FINDINGS[2]?.logId ?? "",
  title: FINDINGS[2]?.title ?? "",
  trackId: "e2e-track-3",
  videoUrl: "https://found.fluncle.com/e2e/story-3.mp4",
} as const;

/** The UNCERTIFIED row in the release band — no `findings` row, so no coordinate and no name. */
export const SEEDED_CATALOGUE_RELEASE = {
  artist: "Ashen Relay",
  title: "Undertow Ledger",
  trackId: "e2e-track-catalogue-1",
};

/**
 * The release dates the front door's window reads. They are a fixed offset back from the seed's own
 * epoch rather than from the clock, so a run is identical every time — but the WINDOW is measured
 * from `new Date()` at request time, so they are also stamped relative to today at seed time. The
 * two are reconciled by seeding "yesterday" and "three days ago" off the real clock: inside every
 * window the page ever asks for, and never a future-dated pre-order (which `/fresh` drops).
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function seedE2eData(client: Client): Promise<void> {
  await seedArtist(client, ARTIST);
  await seedLabel(client, LABEL);
  await seedAlbum(client, ALBUM);

  for (const [index, finding] of FINDINGS.entries()) {
    const trackId = `e2e-track-${index + 1}`;
    // Newer findings first: index 0 is the most recent.
    const addedAt = new Date(BASE_EPOCH_MS - index * 60_000).toISOString();

    await seedTrack(client, {
      addedAt,
      artists: [finding.artist],
      label: LABEL.name,
      logId: finding.logId,
      title: finding.title,
      trackId,
    });
  }

  // Wire the first finding into the full graph (album ↔ label ↔ artist) so a
  // follow-up spec has one finding that resolves every entity page with content.
  await client.execute({
    args: [ALBUM.id, LABEL.id, "e2e-track-1"],
    sql: `update tracks set album_id = ?, label_id = ? where track_id = ?`,
  });
  await client.execute({
    args: ["e2e-track-1", ARTIST.id],
    sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
  });
  // The maintained hub counts the real write paths would have moved (keystone 2,
  // lib/server/hub-counts.ts): one certified finding on each of the ALBUM and ARTIST entities,
  // which are wired to that one track. Seeded here rather than left at the DDL default so the
  // fixture matches what production holds — the entity hubs read these columns. The LABEL's pair
  // is set by `stampLabelPointers` below, once every track that carries its name is pointed at it.
  for (const table of ["albums", "artists"]) {
    await client.execute({
      args: [table === "albums" ? ALBUM.id : ARTIST.id],
      sql: `update ${table} set renderable_track_count = 1, certified_finding_count = 1 where id = ?`,
    });
  }

  // The radio-eligible finding (see RADIO_FINDING above). Seeded like any other,
  // then given the four eligibility columns the base factory does not carry.
  await seedTrack(client, {
    addedAt: new Date(BASE_EPOCH_MS - FINDINGS.length * 60_000).toISOString(),
    artists: [RADIO_FINDING.artist],
    label: LABEL.name,
    logId: RADIO_FINDING.logId,
    title: RADIO_FINDING.title,
    trackId: RADIO_FINDING.trackId,
  });
  await client.execute({
    args: [
      new Date(BASE_EPOCH_MS).toISOString(),
      RADIO_FINDING.observationAudioUrl,
      RADIO_FINDING.observationDurationMs,
      new Date(BASE_EPOCH_MS).toISOString(),
      RADIO_FINDING.trackId,
    ],
    sql: `update findings
          set video_squared_at = ?,
              observation_audio_url = ?,
              observation_duration_ms = ?,
              observation_generated_at = ?
          where track_id = ?`,
  });

  await seedMixtape(client, {
    addedAt: new Date(BASE_EPOCH_MS + 60_000).toISOString(),
    id: MIXTAPE.id,
    logId: MIXTAPE.logId,
    title: MIXTAPE.title,
  });

  await seedFrontDoorFixtures(client);
  await stampLabelPointers(client);
}

/**
 * EVERY track pressed by the seeded label points AT it — the pointer and the raw string say the
 * same thing, which is what production holds and what the fixture used to fake.
 *
 * `linkTrackToLabel` runs on every publish, so a label's name on `tracks.label` and its id on
 * `tracks.label_id` arrive together; `scripts/backfill-labels.ts` (in the deploy chain) reconciles
 * any row that predates its entity. Left half-wired here — one pointer, nine name strings, and a
 * counter claiming one renderable track — the fixture described a world the archive cannot be in,
 * and the `/tracks?label=` filter (which resolves the typed name to `labels.id` and seeks
 * `tracks.label_id`) would read one row where the reader can see nine.
 *
 * The counters are then DERIVED from those pointers rather than typed, so they cannot drift from
 * the rows: `certified_finding_count` reads keystone 1's `is_catalogue = 0` discriminator, exactly
 * as the write sites do.
 */
async function seedFrontDoorFixtures(client: Client): Promise<void> {
  // The EDITED lead: a note on the SECOND finding, so the lead is provably the noted one rather
  // than whichever row happens to be newest. Its cover comes with it — the lead is the LCP element.
  await client.execute({
    args: [SEEDED_LEAD_NOTE, SEEDED_LEAD.trackId],
    sql: `update findings set note = ? where track_id = ?`,
  });
  await client.execute({
    args: [SEEDED_LEAD_COVER_URL, SEEDED_LEAD.trackId],
    sql: `update tracks set album_image_url = ? where track_id = ?`,
  });

  for (const covered of SEEDED_COVERED_FINDINGS) {
    await client.execute({
      args: [covered.coverUrl, covered.trackId],
      sql: `update tracks set album_image_url = ? where track_id = ?`,
    });
  }

  // FOOTAGE on one finding, so the Stories affordance is reachable at all (see SEEDED_STORY_FINDING).
  await client.execute({
    args: [SEEDED_STORY_FINDING.videoUrl, SEEDED_STORY_FINDING.trackId],
    sql: `update findings set video_url = ? where track_id = ?`,
  });

  // The release window: one CERTIFIED finding dated inside it, so the band's lit half has a row.
  await client.execute({
    args: [daysAgo(1), SEEDED_LEAD.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });

  // The UNCERTIFIED half: a `tracks` row with no `findings` row. It is the fixture that proves the
  // release band renders both registers without ever naming the second one.
  await seedCatalogueTrack(client, {
    artists: [SEEDED_CATALOGUE_RELEASE.artist],
    label: LABEL.name,
    title: SEEDED_CATALOGUE_RELEASE.title,
    trackId: SEEDED_CATALOGUE_RELEASE.trackId,
  });
  await client.execute({
    args: [daysAgo(3), SEEDED_CATALOGUE_RELEASE.trackId],
    sql: `update tracks set release_date = ? where track_id = ?`,
  });
}

async function stampLabelPointers(client: Client): Promise<void> {
  await client.execute({
    args: [LABEL.id, LABEL.name],
    sql: `update tracks set label_id = ? where label = ?`,
  });
  await client.execute({
    args: [LABEL.id],
    sql: `update labels
             set renderable_track_count =
                   (select count(*) from tracks where tracks.label_id = labels.id),
                 certified_finding_count =
                   (select count(*) from tracks
                     where tracks.label_id = labels.id and tracks.is_catalogue = 0)
           where id = ?`,
  });
}

/** Standalone entry point (`bun run tests/e2e/seed.ts`) — global-setup imports `seedE2eData`. */
async function main(): Promise<void> {
  const client = createClient({
    authToken: "e2e-local",
    concurrency: LOCAL_DB_CONCURRENCY,
    url: LIBSQL_URL,
  });

  await seedE2eData(client);
  client.close();
  console.log(
    `e2e seed: ${FINDINGS.length + 1} findings (1 radio-eligible) + 1 mixtape + 1 catalogue track + artist/label/album.`,
  );
}

if (import.meta.main) {
  await main();
}
