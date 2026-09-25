import { type Client } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DOCS_PAGES } from "../docs-pages";
import { createIntegrationDb, seedTrack, syncHubCounts } from "./integration-db";
import { renderSitemap } from "./sitemap-test-kit";

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const CERTIFIED = "hospital00certified001";
const CROWDED_LABEL = 900;
const DISCOVERED_LABEL = 400;

async function seedLabel(
  name: string,
  slug: string,
  seedState: string,
  createdAt = "2026-07-01T00:00:00.000Z",
): Promise<string> {
  const id = `lbl_${slug}`;

  await db.execute({
    args: [id, name, slug, seedState, createdAt, createdAt],
    sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });

  return id;
}

const CRAWLED_ARTISTS = 30;
const CRAWLED_ALBUMS = 80;

async function seedCrawledRows(labelId: string, labelName: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    args: [
      `mb_${labelId}_${index}`,
      `${labelName} Crawled ${String(index).padStart(4, "0")}`,

      JSON.stringify([`A Crawled Artist ${String(index % CRAWLED_ARTISTS).padStart(2, "0")}`]),
      `Crawled Record ${String(index % CRAWLED_ALBUMS).padStart(2, "0")}`,
      0,
      labelName,
      labelId,
      `https://open.spotify.com/track/crawled${labelId}${index}`,
      `20${String(10 + (index % 15)).padStart(2, "0")}-01-01`,
    ],
    sql: `insert into tracks
            (track_id, title, artists_json, album, duration_ms, label, label_id, spotify_url,
             release_date)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  }));

  await db.batch(rows, "write");

  const artistNow = "2026-07-01T00:00:00.000Z";

  await db.batch(
    Array.from({ length: CRAWLED_ARTISTS }, (_unused, index) => {
      const name = `A Crawled Artist ${String(index).padStart(2, "0")}`;

      return {
        args: [`art_${labelId}_${index}`, name, `${labelId}-artist-${index}`, artistNow, artistNow],
        sql: `insert or ignore into artists (id, name, slug, created_at, updated_at)
              values (?, ?, ?, ?, ?)`,
      };
    }),
    "write",
  );

  const { backfillArtistLinks } = await import("../../../scripts/backfill-artist-links");

  await backfillArtistLinks(db);
}

beforeAll(async () => {
  db = await createIntegrationDb();

  const hospital = await seedLabel("Hospital Records", "hospital-records", "enabled");
  const metalheadz = await seedLabel("Metalheadz", "metalheadz", "undecided");

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

  await seedCrawledRows(metalheadz, "Metalheadz", DISCOVERED_LABEL);

  await syncHubCounts(db);
});

describe("the catalogue at volume", () => {
  it("seeds exactly what it claims: one finding, a crowded imprint, a discovered one", async () => {
    const tracks = await db.execute("select count(*) as n from tracks");
    const findings = await db.execute("select count(*) as n from findings");

    expect(Number(tracks.rows[0]?.n)).toBe(1 + CROWDED_LABEL + DISCOVERED_LABEL);
    expect(Number(findings.rows[0]?.n)).toBe(1);
  });
});

describe("a label page's quieter rows are GROUPED and BOUNDED, totals counted in SQL", () => {
  it("renders a bounded page of artist groups however crowded the label", async () => {
    const { getLabelBySlug } = await import("./labels");
    const {
      flattenArtistGroups,
      GRAPH_GROUP_PAGE_SIZE,
      GRAPH_GROUP_ROW_CEILING,
      listLabelCatalogue,
    } = await import("./catalogue-groups");
    const label = await getLabelBySlug("hospital-records");

    if (!label) {
      throw new Error("label missing");
    }

    const page = await listLabelCatalogue(label.id, "name", 1);

    expect(page.groups.length).toBeLessThanOrEqual(GRAPH_GROUP_PAGE_SIZE);
    expect(page.totalGroups).toBe(CRAWLED_ARTISTS);
    expect(page.totalTracks).toBe(CROWDED_LABEL);
    expect(page.pageCount).toBe(Math.ceil(CRAWLED_ARTISTS / GRAPH_GROUP_PAGE_SIZE));

    const rendered = flattenArtistGroups(page.groups);

    expect(rendered.length).toBeLessThanOrEqual(GRAPH_GROUP_ROW_CEILING);
    expect(rendered.every((track) => !("logId" in track))).toBe(true);
  });

  it("paginates the groups: page 2 is real, disjoint from page 1, and within the same bound", async () => {
    const { getLabelBySlug } = await import("./labels");
    const { GRAPH_GROUP_PAGE_SIZE, listLabelCatalogue } = await import("./catalogue-groups");
    const label = await getLabelBySlug("hospital-records");

    if (!label) {
      throw new Error("label missing");
    }

    const [one, two] = await Promise.all([
      listLabelCatalogue(label.id, "name", 1),
      listLabelCatalogue(label.id, "name", 2),
    ]);

    expect(two.groups.length).toBeGreaterThan(0);
    expect(two.groups.length).toBeLessThanOrEqual(GRAPH_GROUP_PAGE_SIZE);

    const namesOne = new Set(one.groups.map((group) => group.name));
    const overlap = two.groups.filter((group) => namesOne.has(group.name));

    expect(overlap).toEqual([]);

    expect(one.groups.at(-1)?.name.localeCompare(two.groups[0]?.name ?? "") ?? 0).toBeLessThan(0);
  });

  it("throws for a page past the end, so it can 404 rather than duplicate page 1", async () => {
    const { getLabelBySlug } = await import("./labels");
    const { CataloguePageOutOfRangeError, listLabelCatalogue } = await import("./catalogue-groups");
    const label = await getLabelBySlug("hospital-records");

    if (!label) {
      throw new Error("label missing");
    }

    await expect(listLabelCatalogue(label.id, "name", 999)).rejects.toBeInstanceOf(
      CataloguePageOutOfRangeError,
    );
  });

  it("keeps the page's JSON-LD and markup bounded by the same grouped page", async () => {
    const { resolveLabelPageData } = await import("../../routes/-label-page-data");
    const { flattenArtistGroups, GRAPH_GROUP_ROW_CEILING } = await import("./catalogue-groups");
    const data = await resolveLabelPageData("hospital-records", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    expect(flattenArtistGroups(data.catalogue.groups).length).toBeLessThanOrEqual(
      GRAPH_GROUP_ROW_CEILING,
    );

    expect(data.indexable).toBe(true);
  });
});

describe("a label earns a page on its content, not on Fluncle's", () => {
  it("SERVES the label the crawler discovered, with no findings band and no apology", async () => {
    const { resolveLabelPageData } = await import("../../routes/-label-page-data");

    const data = await resolveLabelPageData("metalheadz", "name", 1);

    if (data.status !== "found") {
      throw new Error("a discovered label must have a page");
    }

    expect(data.findings).toEqual([]);
    expect(data.catalogue.groups.length).toBeGreaterThan(0);

    expect(data.indexable).toBe(true);
  });

  it("still serves the label Fluncle DID certify on, findings first", async () => {
    const { resolveLabelPageData } = await import("../../routes/-label-page-data");
    const data = await resolveLabelPageData("hospital-records", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    expect(data.findings.map((finding) => finding.logId)).toEqual(["004.7.2I"]);
  });

  it("carries BOTH labels in the unified /labels index — certified lit, discovered unlit", async () => {
    const { listLabelsHubPage } = await import("./labels");
    const entries = await listLabelsHubPage(1);

    expect(
      entries.items.map((entry) => ({ certified: entry.certified, slug: entry.slug })),
    ).toEqual([
      { certified: true, slug: "hospital-records" },
      { certified: false, slug: "metalheadz" },
    ]);
    expect(entries.items.find((entry) => entry.slug === "hospital-records")?.trackCount).toBe(
      1 + CROWDED_LABEL,
    );
    expect(entries.items.find((entry) => entry.slug === "metalheadz")?.trackCount).toBe(
      DISCOVERED_LABEL,
    );
    expect(entries.total).toBe(2);
  });
});

describe("the sitemap at catalogue volume", () => {
  it("gives 1,300 crawled TRACKS exactly ZERO URLs of their own", async () => {
    const { xml } = await renderSitemap();
    const locs = xml.match(/<loc>/g) ?? [];

    expect(xml).toContain("/log/004.7.2I");
    expect(xml).toContain("/label/hospital-records");

    expect(xml).toContain("/artist/lbl_hospital-records-artist-0");

    expect(xml).not.toContain("Crawled");
    expect(xml).not.toContain("mb_lbl_");
    expect(xml).not.toContain("/track/");
    expect(locs).toHaveLength(20 + 1 + 2 + 2 * CRAWLED_ARTISTS + DOCS_PAGES.length);
  });

  it("LISTS the discovered label — the page exists, so the sitemap must point at it", async () => {
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

    await Promise.all(
      Array.from({ length: LABEL_REVIEW_QUEUE_LIMIT + 10 }, (_unused, index) =>
        seedLabel(
          `Found Imprint ${index}`,
          `found-imprint-${index}`,
          "undecided",
          "2026-07-02T00:00:00.000Z",
        ),
      ),
    );

    const rows = await listLabelReviewRows();

    expect(rows).toHaveLength(LABEL_REVIEW_QUEUE_LIMIT);

    expect(rows[0]?.name).toBe("Metalheadz");
  });
});
