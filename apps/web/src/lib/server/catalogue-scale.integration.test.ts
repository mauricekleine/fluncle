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
//   2. A label the CRAWLER discovered — zero findings, hundreds of crawled rows hanging off
//      it — got a live, indexable `/label/<slug>` page whose entire content was a wall of
//      Spotify outlinks under the heading "Nothing logged off this one yet." That is a
//      doorway page: a page whose stated subject is a thing that is not on it.
//
// ── THE FIX FOR (2) IS NOT A 404 ────────────────────────────────────────────────────────
// It first shipped as one ("zero findings ⇒ the page 404s"), and that was too blunt. A label
// with 700 crawled releases and no finding is a genuinely useful page — an honest record of
// what that label put out — and throwing it away discards the whole point of having crawled
// it. The page existing was never the problem. The HOLLOW RENDERING was.
//
// So the page stays and the hollow rendering goes: every band on a graph page is CONDITIONAL
// (graph-sections.tsx), so a page with no findings never mentions findings, has no heading
// over an empty band, and apologises for nothing. It is then simply about the tracks it has.
//
// What keeps a STUB out of the index is the thin-content gate, and it counts TOTAL renderable
// tracks — findings plus the quieter rows — because a page is thin or not thin on what it
// RENDERS, never on who wrote it. Two crawled rows: thin, `noindex`, no sitemap slot. Nine
// hundred: a page, and the sitemap carries it.
//
// The rail that never moved, and the one this file still exists to defend: a crawled TRACK is
// never a finding and never earns a `/log` URL, however many of them there are.
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

describe("a label earns a page on its content, not on Fluncle's", () => {
  it("SERVES the label the crawler discovered, with no findings band and no apology", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");

    // Metalheadz has 400 crawled rows and no finding. It is a page: a real record of what the
    // label put out. It used to 404.
    const data = await resolveLabelPageData("metalheadz");

    if (data.status !== "found") {
      throw new Error("a discovered label must have a page");
    }

    // Nothing in the findings band ⇒ FindingsGrid renders nothing at all. No heading, no
    // "Nothing logged off this one yet.", no empty state. That line is what made it a doorway.
    expect(data.findings).toEqual([]);
    expect(data.catalogue.length).toBeGreaterThan(0);
    // 400 crawled rows clears the renderable floor, so it is a real, indexable page.
    expect(data.indexable).toBe(true);
  });

  it("still serves the label Fluncle DID certify on, findings first", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");
    const data = await resolveLabelPageData("hospital-records");

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    expect(data.findings.map((finding) => finding.logId)).toEqual(["004.7.2I"]);
  });

  it("keeps the zero-finding label out of the /labels HUB — that list is Fluncle's own", async () => {
    // The hub and the sitemap answer different questions, and this is the seam. `/labels` says
    // "every label I've pulled a banger off", so a label he has certified nothing on is not on
    // it and would be a lie if it were. The SITEMAP is the machine's complete map of pages that
    // exist, and it DOES carry Metalheadz (asserted below). Narrower hub, complete sitemap.
    const { listLabelsWithFindingCounts } = await import("./labels");
    const entries = await listLabelsWithFindingCounts();

    expect(entries.map((entry) => entry.slug)).toEqual(["hospital-records"]);
    expect(entries[0]).toMatchObject({ catalogueCount: CROWDED_LABEL, findingCount: 1 });
  });
});

describe("the sitemap at catalogue volume", () => {
  it("gives 1,300 crawled TRACKS exactly ZERO URLs of their own", async () => {
    // THE RAIL, and it never moved: a crawled track is not a finding, has no coordinate, and
    // never earns a `/log` URL. The catalogue can grow without bound and the finding count in
    // the sitemap does not move. What the crawl DOES earn is a page for the ENTITY the tracks
    // hang off — which is the next test, and the deliberate reversal.
    const { xml } = await renderSitemap();
    const locs = xml.match(/<loc>/g) ?? [];

    // 10 hubs + 1 finding + 2 label pages (Hospital: 1 finding + 900 rows; Metalheadz: 400
    // rows, no finding — both clear the renderable floor). Not one crawled TRACK earns a URL.
    expect(xml).toContain("/log/004.7.2I");
    expect(xml).toContain("/label/hospital-records");
    expect(xml).not.toContain("Crawled");
    expect(xml).not.toContain("mb_lbl_");
    expect(locs).toHaveLength(13);
  });

  it("LISTS the discovered label — the page exists, so the sitemap must point at it", async () => {
    // The invariant album-entity.md states, in both directions: an indexable page is never
    // orphaned from the sitemap, and the sitemap never points at a page that is not there.
    // Metalheadz now HAS a page (400 crawled rows, past the floor), so the first half of the
    // invariant now obliges the sitemap to carry it. It previously (correctly, for the rule of
    // the day) asserted the exact opposite.
    //
    // This is the assertion that would have caught the orphaning if the 404 had been dropped
    // without touching the sitemap: the page's own `indexable` and the sitemap's membership
    // are computed from the same floor, and they must agree.
    const { xml } = await renderSitemap();

    expect(xml).toContain("/label/metalheadz");
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
