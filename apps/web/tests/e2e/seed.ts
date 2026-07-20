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
import {
  seedAlbum,
  seedArtist,
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
}

/** Standalone entry point (`bun run tests/e2e/seed.ts`) — global-setup imports `seedE2eData`. */
async function main(): Promise<void> {
  const client = createClient({ authToken: "e2e-local", url: LIBSQL_URL });

  await seedE2eData(client);
  client.close();
  console.log(
    `e2e seed: ${FINDINGS.length + 1} findings (1 radio-eligible) + 1 mixtape + artist/label/album.`,
  );
}

if (import.meta.main) {
  await main();
}
