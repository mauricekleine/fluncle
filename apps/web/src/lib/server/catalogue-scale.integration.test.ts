import { type Client } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";
import { renderSitemap } from "./sitemap-test-kit";

// WHAT THE SURFACES DO WHEN THE CATALOGUE IS ACTUALLY BIG.
//
// `findings-certification.integration.test.ts` proves the RAIL — one catalogue track cannot
// pose as a finding. This file proves the BUDGET: the same surfaces, over a catalogue with
// real volume in it, still bound what they read and what they emit.
//
// The two failures it pins both shipped, and both were invisible at 60 rows:
//
//   1. `/label/<slug>` had no LIMIT on its quieter rows. Measured on a 10,800-row synthetic
//      catalogue against the dev stack, `/label/hospital-records` served **4.34 MB of HTML**
//      — 3,000 rows through the markup, again through the hydration payload, and a third time
//      as JSON-LD. An indexed seek that returns 3,000 rows is still 3,000 rows.
//
//   2. A label the CRAWLER discovered — `undecided`, zero findings, hundreds of crawled rows
//      hanging off it — got a live, INDEXABLE `/label/<slug>` page whose entire content was a
//      wall of Spotify outlinks under "Nothing logged off this one yet." Eight of them were
//      live in that same run, and none was in the sitemap (the sitemap inner-joins findings),
//      breaking the invariant album-entity.md states outright.
//
// The rule that falls out, and the one this file exists to defend:
// **the catalogue DEEPENS a page, it never CREATES one.**
//
// It runs on the in-memory libSQL database built from the generated migrations, so the schema
// under test is byte-identical to production. (Volume, never TIMING: AGENTS.md is explicit
// that a local libSQL says nothing honest about speed. What is asserted here is what the code
// READS and EMITS at size — which local proves perfectly well.)

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

/** One certified finding on Hospital, plus the imprint's crawled catalogue behind it. */
const CERTIFIED = "hospital00certified001";
const CROWDED_LABEL = 900;
const DISCOVERED_LABEL = 400;

async function seedLabel(name: string, slug: string, seedState: string): Promise<string> {
  const id = `lbl_${slug}`;

  await db.execute({
    args: [id, name, slug, seedState, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });

  return id;
}

/** The exact shape the crawler writes: a `tracks` row, no `findings` row, label_id stamped. */
async function seedCrawledRows(labelId: string, labelName: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    args: [
      `mb_${labelId}_${index}`,
      `${labelName} Crawled ${String(index).padStart(4, "0")}`,
      JSON.stringify(["A Crawled Artist"]),
      0,
      labelName,
      labelId,
      `https://open.spotify.com/track/crawled${labelId}${index}`,
      `20${String(10 + (index % 15)).padStart(2, "0")}-01-01`,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, duration_ms, label, label_id, spotify_url, release_date)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  }));

  await db.batch(rows, "write");
}

beforeAll(async () => {
  db = await createIntegrationDb();

  const hospital = await seedLabel("Hospital Records", "hospital-records", "enabled");
  const metalheadz = await seedLabel("Metalheadz", "metalheadz", "undecided");

  // The one certified finding on Hospital — the reason the page exists at all.
  await seedTrack(db, {
    label: "Hospital Records",
    logId: "004.7.2I",
    title: "A Certified Track",
    trackId: CERTIFIED,
  });
  await db.execute({
    args: [hospital, CERTIFIED],
    sql: `update tracks set label_id = ? where track_id = ?`,
  });

  await seedCrawledRows(hospital, "Hospital Records", CROWDED_LABEL);
  // Metalheadz: discovered by the walk, never ruled on, never certified. The crawler links
  // its rows to it, so it has plenty of content and zero standing.
  await seedCrawledRows(metalheadz, "Metalheadz", DISCOVERED_LABEL);
});

describe("the catalogue at volume", () => {
  it("seeds exactly what it claims: one finding, a crowded imprint, a discovered one", async () => {
    const tracks = await db.execute("select count(*) as n from tracks");
    const findings = await db.execute("select count(*) as n from findings");

    expect(Number(tracks.rows[0]?.n)).toBe(1 + CROWDED_LABEL + DISCOVERED_LABEL);
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });
});

describe("a graph page's quieter rows are CAPPED, and the total is counted in SQL", () => {
  it("returns at most GRAPH_PAGE_CATALOGUE_LIMIT rows however crowded the imprint", async () => {
    const { getLabelBySlug } = await import("./labels");
    const { GRAPH_PAGE_CATALOGUE_LIMIT, listCatalogueTracksByLabel } = await import("./tracks");
    const label = await getLabelBySlug("hospital-records");

    if (!label) {
      throw new Error("label missing");
    }

    const slice = await listCatalogueTracksByLabel(label.id);

    expect(slice.tracks).toHaveLength(GRAPH_PAGE_CATALOGUE_LIMIT);
    // The honest total still comes back — counted in SQL, never by handing 900 rows to the
    // isolate to length-check. The thin-content gate keys off THIS, not the rendered slice.
    expect(slice.total).toBe(CROWDED_LABEL);
  });

  it("takes the NEWEST releases, not an arbitrary alphabetical A–C slice", async () => {
    const { getLabelBySlug } = await import("./labels");
    const { listCatalogueTracksByLabel } = await import("./tracks");
    const label = await getLabelBySlug("hospital-records");

    if (!label) {
      throw new Error("label missing");
    }

    const releaseDates = await db.execute({
      args: [label.id],
      sql: `select max(release_date) as newest from tracks
            where label_id = ? and track_id like 'mb_%'`,
    });
    const { tracks } = await listCatalogueTracksByLabel(label.id);
    const first = tracks[0];

    if (!first) {
      throw new Error("no rows");
    }

    const firstRow = await db.execute({
      args: [first.trackId],
      sql: `select release_date from tracks where track_id = ?`,
    });

    expect(firstRow.rows[0]?.release_date).toBe(releaseDates.rows[0]?.newest);
  });

  it("keeps the page's JSON-LD and markup bounded by the same slice", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");
    const { GRAPH_PAGE_CATALOGUE_LIMIT } = await import("./tracks");
    const data = await resolveLabelPageData("hospital-records");

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    expect(data.catalogue.length).toBeLessThanOrEqual(GRAPH_PAGE_CATALOGUE_LIMIT);
    // 900 crawled rows still clear the thin-content floor — the gate saw the TOTAL.
    expect(data.indexable).toBe(true);
  });
});

describe("the catalogue DEEPENS a page — it never CREATES one", () => {
  it("404s a label the crawler discovered but Fluncle never certified anything on", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");

    // Metalheadz has 400 crawled rows and a live `labels` row. It has no finding, so it has
    // no page — however much content a crawler hung off it.
    await expect(resolveLabelPageData("metalheadz")).resolves.toEqual({ status: "missing" });
  });

  it("still serves the label Fluncle DID certify on, findings first", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");
    const data = await resolveLabelPageData("hospital-records");

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    expect(data.findings.map((finding) => finding.logId)).toEqual(["004.7.2I"]);
  });

  it("keeps the zero-finding label out of the /labels index too", async () => {
    const { listLabelsWithFindingCounts } = await import("./labels");
    const entries = await listLabelsWithFindingCounts();

    expect(entries.map((entry) => entry.slug)).toEqual(["hospital-records"]);
    expect(entries[0]).toMatchObject({ catalogueCount: CROWDED_LABEL, findingCount: 1 });
  });
});

describe("the sitemap at catalogue volume", () => {
  it("adds exactly ZERO <loc>s for 1,300 crawled rows", async () => {
    const { xml } = await renderSitemap();
    const locs = xml.match(/<loc>/g) ?? [];

    // 10 hubs + 1 finding + 1 label page (Hospital: 1 finding + 900 quieter rows clears the
    // renderable floor). Not one of the 1,300 crawled tracks earns a URL.
    expect(xml).toContain("/log/004.7.2I");
    expect(xml).toContain("/label/hospital-records");
    expect(xml).not.toContain("Crawled");
    expect(xml).not.toContain("mb_lbl_");
    expect(locs).toHaveLength(12);
  });

  it("never lists the discovered label — the page 404s, so the sitemap must not point at it", async () => {
    // The invariant album-entity.md states: an indexable page is never orphaned from the
    // sitemap. Its contrapositive is this one — the sitemap never points at a page that is not
    // there. Both halves now hold at catalogue scale.
    const { xml } = await renderSitemap();

    expect(xml).not.toContain("/label/metalheadz");
  });

  it("stays a sitemap INDEX — the URLs live in children, so it cannot breach 50,000", async () => {
    const { indexXml } = await renderSitemap();

    expect(indexXml).toContain("<sitemapindex");
    expect(indexXml).not.toContain("<url>");
  });
});

describe("the attention queue does not drown in discovered labels", () => {
  it("caps the unruled-label source at a working set", async () => {
    const { LABEL_REVIEW_QUEUE_LIMIT, listLabelReviewRows } = await import("./labels");

    // Every imprint the walk finds mints an `undecided` row. Seed more than the queue's
    // working set and it must still hand back a working set.
    await Promise.all(
      Array.from({ length: LABEL_REVIEW_QUEUE_LIMIT + 10 }, (_unused, index) =>
        seedLabel(`Found Imprint ${index}`, `found-imprint-${index}`, "undecided"),
      ),
    );

    const rows = await listLabelReviewRows();

    expect(rows).toHaveLength(LABEL_REVIEW_QUEUE_LIMIT);
    // Oldest-first: Metalheadz landed before the imprints seeded just now.
    expect(rows[0]?.name).toBe("Metalheadz");
  });
});
