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

// A crawled label is a DISCOGRAPHY, so the synthetic one is spread the way a real one is: many
// artists, each with several records. This is what lets the scale test prove the GROUPING bound
// rather than the old flat cap — a label of `CRAWLED_ARTISTS` artists over `CRAWLED_ALBUMS`
// records, grouped by artist and paged, must still render a bounded page.
const CRAWLED_ARTISTS = 30;
const CRAWLED_ALBUMS = 80;

/** The exact shape the crawler writes: a `tracks` row, no `findings` row, label_id stamped. */
async function seedCrawledRows(labelId: string, labelName: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    args: [
      `mb_${labelId}_${index}`,
      `${labelName} Crawled ${String(index).padStart(4, "0")}`,
      // Spread across artists and records so the grouping has something to group. `A Crawled
      // Artist NN` and `Crawled Record NN` fold to `CRAWLED_ARTISTS` / `CRAWLED_ALBUMS` buckets.
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

  // Link every crawled row to its credited artist entity, exactly as the crawler + the deploy
  // backfill do (lib/server/artists.ts). The label page's ARTIST grouping reads `artists_json`
  // directly, but the ARTIST page reads through this indexed edge, so it must exist for the
  // artist-side bound to be exercised too.
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

    // GROUPS are capped at a page size; the honest group + track totals come back counted in
    // SQL, never by handing 900 rows to the isolate to length-check. The thin-content gate keys
    // off `totalTracks`, and the pager off `totalGroups` — never the rendered page.
    expect(page.groups.length).toBeLessThanOrEqual(GRAPH_GROUP_PAGE_SIZE);
    expect(page.totalGroups).toBe(CRAWLED_ARTISTS);
    expect(page.totalTracks).toBe(CROWDED_LABEL);
    expect(page.pageCount).toBe(Math.ceil(CRAWLED_ARTISTS / GRAPH_GROUP_PAGE_SIZE));

    // THE ROW CEILING — the number that replaces the flat 100-row cap as the thing standing
    // between a crawled label and a 4.34 MB dump. No matter how the rows fall, the page renders
    // at most `pageSize × trackLimit` of them, and every rendered row is a real uncertified
    // track (no coordinate — it can never pose as a finding).
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

    // A pager, not a cap: nothing is unreachable. Page 2 carries the next artists, disjoint from
    // page 1, and both are the same bounded page size.
    expect(two.groups.length).toBeGreaterThan(0);
    expect(two.groups.length).toBeLessThanOrEqual(GRAPH_GROUP_PAGE_SIZE);

    const namesOne = new Set(one.groups.map((group) => group.name));
    const overlap = two.groups.filter((group) => namesOne.has(group.name));

    expect(overlap).toEqual([]);
    // A–Z is stable: page 1 sorts before page 2.
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
    const { resolveLabelPageData } = await import("../../routes/label.$slug");
    const { flattenArtistGroups, GRAPH_GROUP_ROW_CEILING } = await import("./catalogue-groups");
    const data = await resolveLabelPageData("hospital-records", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the page to resolve");
    }

    // The markup, the hydration payload and the JSON-LD's track list are all bounded by this one
    // flattened array — never 900 rows through the markup three times over (the 4.34 MB bug).
    expect(flattenArtistGroups(data.catalogue.groups).length).toBeLessThanOrEqual(
      GRAPH_GROUP_ROW_CEILING,
    );
    // 900 crawled rows still clear the thin-content floor — the gate saw the TOTAL.
    expect(data.indexable).toBe(true);
  });
});

describe("a label earns a page on its content, not on Fluncle's", () => {
  it("SERVES the label the crawler discovered, with no findings band and no apology", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");

    // Metalheadz has 400 crawled rows and no finding. It is a page: a real record of what the
    // label put out. It used to 404.
    const data = await resolveLabelPageData("metalheadz", "name", 1);

    if (data.status !== "found") {
      throw new Error("a discovered label must have a page");
    }

    // Nothing in the findings band ⇒ FindingsGrid renders nothing at all. No heading, no
    // "Nothing logged off this one yet.", no empty state. That line is what made it a doorway.
    expect(data.findings).toEqual([]);
    expect(data.catalogue.groups.length).toBeGreaterThan(0);
    // 400 crawled rows clears the renderable floor, so it is a real, indexable page.
    expect(data.indexable).toBe(true);
  });

  it("still serves the label Fluncle DID certify on, findings first", async () => {
    const { resolveLabelPageData } = await import("../../routes/label.$slug");
    const data = await resolveLabelPageData("hospital-records", "name", 1);

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
    // never earns a `/log` URL (nor a `/track` one — there is no such route). The catalogue can
    // grow without bound and the finding count in the sitemap does not move. What the crawl DOES
    // earn is a page for the ENTITIES the tracks hang off — the label AND, now, every crawled
    // artist with enough catalogue tracks to clear the thin-content floor.
    const { xml } = await renderSitemap();
    const locs = xml.match(/<loc>/g) ?? [];

    // 15 hubs + 1 finding + 2 label pages (Hospital: 1 finding + 900 rows; Metalheadz: 400 rows,
    // no finding — both clear the floor) + 60 crawled artist pages (CRAWLED_ARTISTS per label, a
    // distinct entity each, every one well past the floor). No `albums` rows are minted in this
    // seed, so no album <loc>. `/mix` is dark (the crawled tracks carry no key, so the depth gate
    // stays closed) and `/galaxies` is dark (no named map). Not one crawled TRACK earns a URL.
    expect(xml).toContain("/log/004.7.2I");
    expect(xml).toContain("/label/hospital-records");
    // A findings-free discovered artist now has a public page, so the sitemap points at it.
    expect(xml).toContain("/artist/lbl_hospital-records-artist-0");
    // The RAIL: no crawled TRACK title, id, or `/log`/`/track` URL leaks in.
    expect(xml).not.toContain("Crawled");
    expect(xml).not.toContain("mb_lbl_");
    expect(xml).not.toContain("/track/");
    expect(locs).toHaveLength(15 + 1 + 2 + 2 * CRAWLED_ARTISTS);
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
