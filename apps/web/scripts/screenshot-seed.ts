#!/usr/bin/env bun
/**
 * Seed the LOCAL dev database with the synthetic App Store screenshot dataset.
 *
 *   bun run --cwd apps/web screenshot:seed
 *
 * WHY. Apple rejected mobile 1.0 under Guideline 5.2.1: the store screenshots showed real
 * album covers and Spotify artist photos Fluncle holds no rights to. The remedy is to
 * re-shoot every affected slot against a dataset whose artwork is Fluncle's own generated
 * art. This writes that dataset. The art itself comes from
 * `bun run --cwd packages/media render:screenshot-assets`, and both sides read the SAME
 * fixture list (`@fluncle/test-support/screenshot-fixtures`) so a rendered file name and a
 * seeded image URL can never drift. Full runbook: docs/mobile-store-screenshots.md.
 *
 * IT CANNOT TOUCH PRODUCTION. `assertLocalDatabaseUrl` refuses any URL that is not
 * localhost / 127.0.0.1 / a file, and refuses `turso.io` by name — a hard exit before a
 * single statement runs. The guard is unit-tested (screenshot-seed.test.ts), because a
 * seed script that can reach prod is a seed script that eventually does.
 *
 * IT IS IDEMPOTENT. Every row it writes carries the `shot-` id prefix, and the run starts
 * by deleting exactly those rows, children first. Nothing it did not create is touched, so
 * this is safe to re-run over a dev DB seeded from a prod snapshot.
 *
 * SHAPES COME FROM THE REAL FACTORIES. It reuses `src/lib/server/integration-db`'s
 * `seedTrack` / `seedArtist` / `seedMixtape` / … — the same ones the integration suite and
 * the e2e seed use — so a schema change breaks this loudly instead of silently seeding a
 * world production cannot be in. The hub counters are then reconciled by the REAL deploy
 * backfill (`syncHubCounts`), never by re-stating the arithmetic here.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  avatarUrl,
  SCREENSHOT_ARTISTS,
  SCREENSHOT_ASSET_BASE,
  SCREENSHOT_FINDINGS,
  SCREENSHOT_GALAXIES,
  SCREENSHOT_ID_PREFIX,
  SCREENSHOT_MIXTAPE,
  sleeveUrl,
} from "@fluncle/test-support/screenshot-fixtures";
import {
  seedAlbum,
  seedArtist,
  seedEmbedding,
  seedLabel,
  seedMixtape,
  seedTrack,
  syncHubCounts,
} from "../src/lib/server/integration-db";
import { EMBEDDING_DIMS } from "../src/lib/server/embedding";

/**
 * The one synthetic label and album the graph hangs off. Slugs carry the prefix as well as
 * the ids: a dev DB cloned from a prod snapshot already holds entities, and `slug` is UNIQUE
 * on all three graph tables.
 */
const LABEL = {
  id: `${SCREENSHOT_ID_PREFIX}label-driftwave`,
  name: "Driftwave Audio",
  slug: `${SCREENSHOT_ID_PREFIX}driftwave-audio`,
};
const ALBUM = {
  id: `${SCREENSHOT_ID_PREFIX}album-signal`,
  name: "Signal Bloom",
  slug: `${SCREENSHOT_ID_PREFIX}signal-bloom`,
};

/** A fixed base epoch, so a re-run produces byte-identical found dates. */
const BASE_EPOCH_MS = Date.UTC(2026, 6, 20, 21, 0, 0);

/** How many findings ride the mixtape's tracklist (its "N bangers" meta line). */
const MIXTAPE_MEMBERS = 8;

/** Ten minutes — far longer than any capture session, so the radio never rolls mid-shot. */
const RADIO_OBSERVATION_MS = 600_000;

// ── The safety guard ─────────────────────────────────────────────────────────

/** Thrown when the resolved database URL is anything but a local one. */
export class NonLocalDatabaseError extends Error {}

/**
 * Refuse to run against anything that is not a LOCAL database.
 *
 * Two independent tests, because either alone has a hole: hosted Turso is named
 * explicitly (a `libsql://…turso.io` URL would otherwise have to be caught by the host
 * allowlist alone), and the host must be loopback (or the URL a plain `file:` / bare path,
 * which is how `:memory:` and `.dev/local.db` arrive). Anything else — a tunnel, a LAN IP,
 * a staging host — is refused rather than guessed at.
 */
export function assertLocalDatabaseUrl(url: string): void {
  const trimmed = url.trim();

  if (trimmed.length === 0) {
    throw new NonLocalDatabaseError("TURSO_DATABASE_URL is empty");
  }
  if (trimmed.toLowerCase().includes("turso.io")) {
    throw new NonLocalDatabaseError(
      `refusing to seed ${trimmed}: that is hosted Turso. The screenshot seed is LOCAL-ONLY.`,
    );
  }

  // A bare path or an explicit file URL is a local SQLite file — allowed.
  if (trimmed.startsWith("file:") || trimmed === ":memory:" || !trimmed.includes("://")) {
    return;
  }

  let host: string;

  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    throw new NonLocalDatabaseError(`refusing to seed ${trimmed}: not a parseable database URL`);
  }

  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new NonLocalDatabaseError(
      `refusing to seed ${trimmed}: host "${host}" is not local. The screenshot seed is LOCAL-ONLY.`,
    );
  }
}

// ── Deterministic embeddings ─────────────────────────────────────────────────

/**
 * A deterministic MuQ-shaped vector per fixture, laid out so the Decks rail has real work.
 *
 * THE VECTOR IS NOT OPTIONAL. Two of the three Decks reads gate on it outright —
 * `listMixableArtists` (the taste grid) and `getMixOpeners` both filter
 * `tracks.embedding_blob is not null`, so an artist with no embedded track never appears in
 * the picker at all. Fourteen embedded tracks is 91 pairs, past `MIN_EMBEDDED_PAIRS`, so the
 * sonic term is LIVE and taste re-ranks the rail.
 *
 * So the vectors cannot be noise: independent random 1024-d vectors are near-orthogonal, the
 * calibration floor (`SONIC_CALIBRATION.lo = 0.5`) clamps every cosine to 0, and the whole
 * rail scores a flat zero on taste. Instead each fixture sits at its own angle on ONE plane
 * spanned by two fixed orthonormal vectors, so pairwise cosines land in ~[0.62, 1.0] — spread
 * across the live part of the calibration, which is what makes the rail's order visibly mean
 * something in a screenshot.
 */
function fixtureEmbedding(index: number, total: number): number[] {
  const u = unitVector(11);
  const v = orthonormalize(unitVector(29), u);
  // Spread the fixtures over 0.9 rad so the extreme pair still reads as "close in sound".
  const theta = (index / Math.max(1, total - 1)) * 0.9;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  return u.map((component, dim) => component * cos + (v[dim] ?? 0) * sin);
}

/** A deterministic unit vector of {@link EMBEDDING_DIMS} components, from a small integer seed. */
function unitVector(seed: number): number[] {
  // A mulberry32-style LCG: deterministic, dependency-free, and stable across runs.
  let state = seed * 0x9e3779b9;
  const raw = Array.from({ length: EMBEDDING_DIMS }, () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });

  return normalize(raw);
}

/** Gram-Schmidt: the component of `vector` orthogonal to the unit vector `basis`, normalized. */
function orthonormalize(vector: number[], basis: number[]): number[] {
  const dot = vector.reduce((sum, component, dim) => sum + component * (basis[dim] ?? 0), 0);

  return normalize(vector.map((component, dim) => component - dot * (basis[dim] ?? 0)));
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0)) || 1;

  return vector.map((component) => component / norm);
}

// ── The seed ─────────────────────────────────────────────────────────────────

/** Delete every row this dataset owns, children before parents. Never touches anything else. */
async function clearSyntheticRows(client: Client): Promise<void> {
  const like = `${SCREENSHOT_ID_PREFIX}%`;
  const statements: { args: string[]; sql: string }[] = [
    { args: [like], sql: `delete from mixtape_tracks where mixtape_id like ?` },
    { args: [like], sql: `delete from mixtapes where id like ?` },
    { args: [like], sql: `delete from track_artists where track_id like ?` },
    { args: [like], sql: `delete from findings where track_id like ?` },
    { args: [like], sql: `delete from tracks where track_id like ?` },
    { args: [like], sql: `delete from artists where id like ?` },
    { args: [like], sql: `delete from labels where id like ?` },
    { args: [like], sql: `delete from albums where id like ?` },
    { args: [like], sql: `delete from galaxies where id like ?` },
  ];

  for (const statement of statements) {
    await client.execute(statement);
  }
}

/** The `tracks.track_id` for a fixture slug. */
function trackIdOf(slug: string): string {
  return `${SCREENSHOT_ID_PREFIX}track-${slug}`;
}

/** The `artists.id` for a fixture artist slug. */
function artistIdOf(slug: string): string {
  return `${SCREENSHOT_ID_PREFIX}artist-${slug}`;
}

/** The `galaxies.id` for a fixture galaxy slug. */
function galaxyIdOf(slug: string): string {
  return `${SCREENSHOT_ID_PREFIX}galaxy-${slug}`;
}

/**
 * Write the whole synthetic dataset. Exported so a future test (or a harness) can drive it
 * against an in-memory database with the real migrations applied.
 */
export async function seedScreenshotData(client: Client, assetBase: string): Promise<void> {
  await clearSyntheticRows(client);

  const now = new Date(BASE_EPOCH_MS).toISOString();

  // The sonic galaxies — the archive row's third meta segment. A galaxy is only NAMED
  // (and therefore only rendered) when an operator has named it, so these carry a name.
  for (const galaxy of SCREENSHOT_GALAXIES) {
    await client.execute({
      // Handle AND slug carry the prefix too: a dev DB cloned from a prod snapshot already
      // holds named galaxies, and both columns are UNIQUE.
      args: [
        galaxyIdOf(galaxy.slug),
        `${SCREENSHOT_ID_PREFIX}g-${galaxy.slug}`,
        galaxy.name,
        `${SCREENSHOT_ID_PREFIX}${galaxy.slug}`,
        now,
        now,
      ],
      sql: `insert into galaxies (id, handle, name, slug, centroid_json, created_at, updated_at)
            values (?, ?, ?, ?, '[]', ?, ?)`,
    });
  }

  await seedLabel(client, LABEL);
  await seedAlbum(client, ALBUM);

  for (const artist of SCREENSHOT_ARTISTS) {
    await seedArtist(client, {
      id: artistIdOf(artist.slug),
      name: artist.name,
      // The slug carries the prefix too — a prod-snapshot dev DB may already hold this
      // name, and `artists.slug` is UNIQUE.
      slug: `${SCREENSHOT_ID_PREFIX}${artist.slug}`,
    });
    await client.execute({
      args: [avatarUrl(artist.slug, assetBase), artistIdOf(artist.slug)],
      sql: `update artists set image_url = ? where id = ?`,
    });
  }

  for (const [index, finding] of SCREENSHOT_FINDINGS.entries()) {
    const trackId = trackIdOf(finding.slug);
    const artistName =
      SCREENSHOT_ARTISTS.find((artist) => artist.slug === finding.artistSlug)?.name ??
      finding.artistSlug;
    // Newest first: index 0 is the most recent finding, one day apart so the "found" dates
    // in a screenshot read as a real run of nights rather than a burst.
    const addedAt = new Date(BASE_EPOCH_MS - index * 86_400_000).toISOString();

    await seedTrack(client, {
      addedAt,
      artists: [artistName],
      label: LABEL.name,
      logId: finding.logId,
      title: finding.title,
      trackId,
    });

    // The columns the factory does not carry: the sleeve, the two chips the rows render,
    // and the popularity `getMixOpeners` orders by within each register.
    await client.execute({
      args: [
        sleeveUrl(finding.slug, assetBase),
        finding.bpm,
        finding.key,
        ALBUM.id,
        LABEL.id,
        90 - index,
        trackId,
      ],
      sql: `update tracks
            set album_image_url = ?, bpm = ?, key = ?, album_id = ?, label_id = ?, popularity = ?
            where track_id = ?`,
    });
    await client.execute({
      args: [finding.note, galaxyIdOf(finding.galaxySlug), trackId],
      sql: `update findings set note = ?, galaxy_id = ? where track_id = ?`,
    });
    await seedEmbedding(client, trackId, fixtureEmbedding(index, SCREENSHOT_FINDINGS.length));
    await client.execute({
      args: [trackId, artistIdOf(finding.artistSlug)],
      sql: `insert into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    });

    // The RADIO finding: the four columns `getRadioEligibleTracks` predicates on. The
    // observation URL is a real found.fluncle.com shape (Fluncle's own recorded voice, never
    // a commercial recording); against a synthetic coordinate it 404s and the surface opens
    // on its own bounded timer, which is a perfectly shootable state. Point
    // SCREENSHOT_RADIO_OBSERVATION_URL at a real published observation to hear it play.
    if (finding.radio) {
      await client.execute({
        args: [
          now,
          process.env.SCREENSHOT_RADIO_OBSERVATION_URL ??
            `https://found.fluncle.com/${finding.logId}/observation.mp3`,
          RADIO_OBSERVATION_MS,
          now,
          trackId,
        ],
        sql: `update findings
              set video_squared_at = ?,
                  observation_audio_url = ?,
                  observation_duration_ms = ?,
                  observation_generated_at = ?
              where track_id = ?`,
      });
    }
  }

  // The one published mixtape. Its cover is Fluncle's OWN render, served on the fly by the
  // local worker (`/api/mixtape-cover/<logId>`), so the Mixtapes tab needs no image fixture —
  // only a mixtape whose tracklist is real, which is what the members below give it.
  const mixtapeId = `${SCREENSHOT_ID_PREFIX}mixtape-1`;

  await seedMixtape(client, {
    addedAt: new Date(BASE_EPOCH_MS + 3_600_000).toISOString(),
    id: mixtapeId,
    logId: SCREENSHOT_MIXTAPE.logId,
    note: "Eight findings, one long dream. Mixed the night the sector went quiet.",
    sequenceNumber: SCREENSHOT_MIXTAPE.sequenceNumber,
    title: SCREENSHOT_MIXTAPE.title,
  });

  for (const [position, finding] of SCREENSHOT_FINDINGS.slice(0, MIXTAPE_MEMBERS).entries()) {
    const trackId = trackIdOf(finding.slug);

    await client.execute({
      args: [mixtapeId, trackId, trackId, position + 1, position * 420_000],
      sql: `insert into mixtape_tracks (mixtape_id, track_id, finding_id, position, start_ms)
            values (?, ?, ?, ?, ?)`,
    });
  }

  // The maintained hub counters, moved by the REAL deploy backfill rather than re-derived
  // here — the entity hubs read those two integers, so a fixture that leaves them at the DDL
  // default describes a world the archive cannot be in.
  await syncHubCounts(client);
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  try {
    assertLocalDatabaseUrl(url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const assetBase = process.env.SCREENSHOT_ASSET_BASE ?? SCREENSHOT_ASSET_BASE;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });

  await seedScreenshotData(client, assetBase);
  client.close();

  console.log(
    `screenshot seed: ${SCREENSHOT_FINDINGS.length} findings (1 radio-eligible) + ` +
      `${SCREENSHOT_ARTISTS.length} artists + 1 mixtape (${MIXTAPE_MEMBERS} members) into ${url}.`,
  );
  console.log(`screenshot seed: artwork expected at ${assetBase}/{sleeves,avatars}/<slug>.png`);
}

if (import.meta.main) {
  await main();
}
