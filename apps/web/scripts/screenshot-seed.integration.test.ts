// THE SCREENSHOT DATASET, PROVEN AGAINST THE REAL READS.
//
// The whole point of the seed is that an operator can open the simulator and shoot. If a
// surface comes up empty — the Decks taste grid with no artists, the rail with "Quiet
// sector tonight", the Radio with nothing eligible — that is discovered mid-capture, with
// the simulator open and the runbook half-done. The failure modes are not hypothetical
// either: `listMixableArtists` and `getMixOpeners` both gate on `embedding_blob is not
// null`, and `scoreMix` drops any pair whose key it cannot parse, so a fixture list that
// forgets a vector or misspells a key silently yields an empty tool.
//
// So this drives the REAL query functions (a `vi.mock("./db")` onto an in-memory libSQL
// database with the generated migrations applied — the integration-db discipline) over the
// dataset the seed actually writes, and asserts each screenshot surface has something on it.

import { type Client } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  SCREENSHOT_ARTISTS,
  SCREENSHOT_FINDINGS,
  SCREENSHOT_MIXTAPE,
} from "@fluncle/test-support/screenshot-fixtures";

import { createIntegrationDb, rowCount } from "../src/lib/server/integration-db";
import { seedScreenshotData } from "./screenshot-seed";

let db: Client;

vi.mock("../src/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server/db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const ASSET_BASE = "http://127.0.0.1:8899";

beforeAll(async () => {
  db = await createIntegrationDb();
  await seedScreenshotData(db, ASSET_BASE);
});

describe("the screenshot seed", () => {
  it("writes the fixture list, and only rows it owns", async () => {
    expect(await rowCount(db, "findings")).toBe(SCREENSHOT_FINDINGS.length);
    expect(await rowCount(db, "artists")).toBe(SCREENSHOT_ARTISTS.length);
    expect(await rowCount(db, "mixtapes")).toBe(1);
    expect(await rowCount(db, "mixtape_tracks")).toBe(8);
  });

  it("points every cover and every artist face at the rendered own-IP art", async () => {
    const covers = await db.execute(`select album_image_url as url from tracks`);
    const faces = await db.execute(`select image_url as url from artists`);
    const urls = [...covers.rows, ...faces.rows].map(
      (row) => (row as unknown as { url: string }).url,
    );

    expect(urls).toHaveLength(SCREENSHOT_FINDINGS.length + SCREENSHOT_ARTISTS.length);
    for (const url of urls) {
      expect(url.startsWith(`${ASSET_BASE}/`)).toBe(true);
      expect(url.endsWith(".png")).toBe(true);
    }
  });

  it("fills the Decks taste grid — every artist clears the key + vector gate", async () => {
    const { listMixableArtists } = await import("../src/lib/server/tracks");
    const artists = await listMixableArtists();

    expect(artists).toHaveLength(SCREENSHOT_ARTISTS.length);
    expect(artists.every((artist) => Boolean(artist.imageUrl))).toBe(true);
  });

  it("offers openers for a seeded artist", async () => {
    const { getMixOpeners } = await import("../src/lib/server/tracks");
    const first = SCREENSHOT_ARTISTS[0];
    const openers = await getMixOpeners([`shot-${first?.slug ?? ""}`]);

    expect(openers.length).toBeGreaterThan(0);
    expect(openers.every((track) => track.certified)).toBe(true);
  });

  it("still ranks a full rail four deep into a chain", async () => {
    const { getMixableTracks } = await import("../src/lib/server/tracks");
    const chain = SCREENSHOT_FINDINGS.slice(0, 4).map((finding) => finding.logId);
    const tail = chain[chain.length - 1] ?? "";
    const rail = await getMixableTracks(tail, { exclude: chain });

    // The keys are chosen so the tail still reaches most of the remaining ten by a NAMED
    // harmonic move — the rail must not fall back to its empty state at the exact depth a
    // screenshot shows it.
    expect(rail.length).toBeGreaterThanOrEqual(4);
    expect(rail.every((candidate) => Boolean(candidate.reason))).toBe(true);
    // Nothing already in the chain may be offered again.
    expect(rail.some((candidate) => chain.includes(candidate.logId ?? ""))).toBe(false);
  });

  it("has exactly one radio-eligible finding", async () => {
    const { getRadioEligibleTracks } = await import("../src/lib/server/tracks");
    const eligible = await getRadioEligibleTracks();
    const expected = SCREENSHOT_FINDINGS.find((finding) => finding.radio);

    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.logId).toBe(expected?.logId);
  });

  it("lists one published mixtape carrying a real tracklist", async () => {
    const { listMixtapes } = await import("../src/lib/server/mixtapes");
    const mixtapes = await listMixtapes();

    expect(mixtapes).toHaveLength(1);
    expect(mixtapes[0]?.logId).toBe(SCREENSHOT_MIXTAPE.logId);
    expect(mixtapes[0]?.memberCount).toBe(8);
  });

  it("is idempotent — a second run replaces its own rows rather than doubling them", async () => {
    await seedScreenshotData(db, ASSET_BASE);

    expect(await rowCount(db, "findings")).toBe(SCREENSHOT_FINDINGS.length);
    expect(await rowCount(db, "tracks")).toBe(SCREENSHOT_FINDINGS.length);
    expect(await rowCount(db, "track_artists")).toBe(SCREENSHOT_FINDINGS.length);
    expect(await rowCount(db, "mixtape_tracks")).toBe(8);
  });
});
