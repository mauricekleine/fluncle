import { type Client, type InStatement } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: Client;
vi.mock("./db", async () => ({
  ...(await vi.importActual<typeof import("./db")>("./db")),
  getDb: async () => db,
}));

import { typedRows } from "./db";
import { createIntegrationDb } from "./integration-db";
import { buildIndexNowPayload } from "./indexnow";
import {
  INDEXNOW_WINDOW_SIZE,
  ackIndexNowCatalogue,
  claimIndexNowCatalogue,
  walkIndexNowCatalogue,
  type IndexNowCursor,
} from "./indexnow-catalogue";

const ORIGINAL = "2026-07-01T00:00:00.000Z";
const OBSERVED = "2026-10-05T00:00:00.000Z";

async function seedCatalogue(count = 3): Promise<void> {
  await db.batch(
    [
      {
        args: [ORIGINAL, ORIGINAL],
        sql: "insert into artists (id,name,slug,created_at,updated_at,renderable_track_count,certified_finding_count) values ('artist','Artist','artist',?,?,3,1)",
      },
      {
        args: [ORIGINAL, ORIGINAL],
        sql: "insert into albums (id,name,slug,created_at,updated_at,renderable_track_count,certified_finding_count) values ('album','Album','album',?,?,3,1)",
      },
      {
        args: [ORIGINAL, ORIGINAL],
        sql: "insert into labels (id,name,slug,created_at,updated_at,renderable_track_count,certified_finding_count) values ('label','Label','label',?,?,3,1)",
      },
      ...Array.from({ length: count }, (_, index) => ({
        args: [String(index).padStart(6, "0")],
        sql: `insert into tracks (track_id,title,artists_json,duration_ms,is_catalogue,album_id,label_id,release_date,album_image_url,spotify_url)
        values (?,'Track','["Artist"]',270000,1,'album','label','2026-07-01','https://example.com/cover.jpg','https://example.com/listen')`,
      })),
      ...Array.from({ length: count }, (_, index) => ({
        args: [String(index).padStart(6, "0")],
        sql: "insert into track_artists (track_id,artist_id,position) values (?,'artist',0)",
      })),
      {
        args: [ORIGINAL],
        sql: "insert into findings (track_id,log_id,added_at) values ('000000','001.0.0A',?)",
      },
      {
        args: [ORIGINAL, ORIGINAL, ORIGINAL],
        sql: "insert into mixtapes (id,title,log_id,status,created_at,updated_at,added_at) values ('mix','Mix','001.0.0B','published',?,?,?)",
      },
    ],
    "write",
  );
}

async function walkAll(): Promise<void> {
  let cursor: IndexNowCursor | null = { kind: "log" };
  while (cursor) {
    cursor = (await walkIndexNowCatalogue(cursor)).next;
  }
}

async function versions() {
  return typedRows<{
    kind: string;
    subject_id: string;
    changed_at: string;
    submitted_at: string | null;
    fingerprint: string;
  }>((await db.execute("select * from search_page_versions order by kind,subject_id")).rows);
}

beforeEach(async () => {
  db = await createIntegrationDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OBSERVED);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 202 })),
  );
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("observed catalogue versions", () => {
  it("observes chronological neighbors and the public galaxy naming gate", async () => {
    await seedCatalogue();
    await walkAll();
    await db.execute(
      `insert into findings (track_id,log_id,added_at) values ('000001','002.0.0A','2026-07-02')`,
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1, inserted: 1 });
    await db.batch(
      [
        {
          args: [ORIGINAL, ORIGINAL],
          sql: "insert into galaxies (id,handle,name,slug,centroid_json,created_at,updated_at) values ('named','named','Named','named','[]',?,?)",
        },
        {
          args: [ORIGINAL, ORIGINAL],
          sql: "insert into galaxies (id,handle,centroid_json,created_at,updated_at) values ('unnamed','unnamed','[]',?,?)",
        },
        { args: [], sql: "update findings set galaxy_id = 'named' where track_id = '000000'" },
      ],
      "write",
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 0 });
    await db.execute("update galaxies set name = 'Other', slug = 'other' where id = 'unnamed'");
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1 });
    await db.execute("update galaxies set name = 'Renamed' where id = 'named'");
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1 });
  });

  it("resumes bounded finding and mixtape windows without losing their shared boundary", async () => {
    await seedCatalogue(INDEXNOW_WINDOW_SIZE);
    await db.batch(
      Array.from({ length: INDEXNOW_WINDOW_SIZE - 1 }, (_, index) => ({
        args: [
          String(index + 1).padStart(6, "0"),
          `002.${String(index + 1).padStart(2, "0")}.0A`,
          ORIGINAL,
        ],
        sql: "insert into findings (track_id,log_id,added_at) values (?,?,?)",
      })),
      "write",
    );
    const alignment = JSON.stringify({
      words: Array.from({ length: 80 }, (_, index) => ({
        endMs: index * 400 + 350,
        startMs: index * 400,
        text: "bass",
      })),
    });
    await db.execute({
      args: [alignment],
      sql: "update findings set observation_alignment_json = ?",
    });
    const executed = vi.spyOn(db, "execute");
    const started = performance.now();
    const first = await walkIndexNowCatalogue({ kind: "log" });
    const elapsed = performance.now() - started;
    const result = await executed.mock.results[0]?.value;
    const bytes = new TextEncoder().encode(JSON.stringify(result?.rows)).byteLength;
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
    expect(first).toMatchObject({
      checked: INDEXNOW_WINDOW_SIZE,
      inserted: INDEXNOW_WINDOW_SIZE,
    });
    if (!first.next) {
      throw new Error("log cursor missing");
    }
    expect(first.next.kind).toBe("log");
    expect(await walkIndexNowCatalogue(first.next)).toMatchObject({
      checked: 1,
      inserted: 1,
      next: { kind: "artist" },
    });
    expect((await versions()).filter((row) => row.kind === "log")).toHaveLength(
      INDEXNOW_WINDOW_SIZE + 1,
    );
    console.log(
      `IndexNow log window: ${first.checked} subjects, ${bytes} bytes, ${elapsed.toFixed(1)}ms`,
    );
  });

  it.each(["artist", "label", "album"] as const)(
    "observes %s facts in bounded windows and resumes their cursor",
    async (kind) => {
      await seedCatalogue();
      const statements: InStatement[] = [];
      for (let index = 0; index < INDEXNOW_WINDOW_SIZE; index += 1) {
        const id = `z-${String(index).padStart(6, "0")}`;
        statements.push({
          args: [id, id, "Entity biography. ".repeat(40), ORIGINAL, ORIGINAL],
          sql: `insert into ${kind}s (id,name,slug,bio,created_at,updated_at,renderable_track_count,certified_finding_count,latest_release_date) values (?,'Entity',?,?,?,?,240,1,'2026-07-01')`,
        });
        if (kind === "artist") {
          statements.push(
            {
              args: [id, id, id, ORIGINAL],
              sql: "insert into artist_aliases (id,artist_id,alias,alias_slug,created_at,kind,source,status) values (?,?,'Alias',?,?,'name','operator','confirmed')",
            },
            {
              args: [id, id, ORIGINAL, ORIGINAL],
              sql: "insert into artist_socials (id,artist_id,created_at,updated_at,platform,url,source,status) values (?,?,?,?,'bandcamp','https://example.com/listen','operator','confirmed')",
            },
          );
        }
      }
      await db.batch(statements, "write");
      const executed = vi.spyOn(db, "execute");
      const started = performance.now();
      const first = await walkIndexNowCatalogue({ kind });
      const elapsed = performance.now() - started;
      expect(first).toMatchObject({
        checked: INDEXNOW_WINDOW_SIZE,
        inserted: INDEXNOW_WINDOW_SIZE,
        next: { after: `z-${String(INDEXNOW_WINDOW_SIZE - 2).padStart(6, "0")}`, kind },
      });
      const result = await executed.mock.results[0]?.value;
      const bytes = new TextEncoder().encode(JSON.stringify(result?.rows)).byteLength;
      expect(bytes).toBeLessThan(10 * 1024 * 1024);
      if (!first.next) {
        throw new Error("entity cursor missing");
      }
      expect(await walkIndexNowCatalogue(first.next)).toMatchObject({
        checked: 1,
        next: { kind: kind === "artist" ? "label" : kind === "label" ? "album" : "track" },
      });
      console.log(
        `IndexNow ${kind} window: ${first.checked} subjects, ${bytes} bytes, ${elapsed.toFixed(1)}ms`,
      );
    },
  );

  it("tracks own visible covers while suppressing hidden fallbacks", async () => {
    await seedCatalogue();
    await db.execute(
      "update albums set image_key = 'covers/master.jpg',image_state = 'resolved',image_updated_at = '2026-07-01'",
    );
    await db.execute(
      "update artists set image_key = 'artists/master.jpg',image_state = 'resolved',image_updated_at = '2026-07-01',image_url = 'https://example.com/avatar.jpg'",
    );
    await db.execute(
      "update labels set image_key = 'labels/logo.jpg',image_state = 'pending',image_updated_at = '2026-07-01'",
    );
    await walkAll();
    const before = await versions();
    await db.execute("update tracks set album_image_url = 'https://example.com/refreshed.jpg'");
    await db.execute("update artists set image_url = 'https://example.com/refreshed.jpg'");
    await walkAll();
    expect(await versions()).toEqual(before);
    vi.setSystemTime("2026-10-06T00:00:00.000Z");
    await db.execute("update labels set image_updated_at = '2026-10-06'");
    expect(await walkIndexNowCatalogue({ kind: "label" })).toMatchObject({ changed: 1 });
  });

  it("dates entity facts and maintained summaries while child edits date their own tracks", async () => {
    await seedCatalogue();
    await walkAll();
    const before = await versions();
    await db.execute(
      "update tracks set title = 'Child title', bpm = 174, key = 'F minor' where track_id = '000002'",
    );
    expect(await walkIndexNowCatalogue({ kind: "artist" })).toMatchObject({ changed: 0 });
    expect(await walkIndexNowCatalogue({ kind: "album" })).toMatchObject({ changed: 0 });
    expect(await walkIndexNowCatalogue({ kind: "label" })).toMatchObject({ changed: 0 });
    expect(await versions()).toEqual(before);
    expect(await walkIndexNowCatalogue({ kind: "track" })).toMatchObject({ changed: 1 });
    for (const kind of ["artist", "album", "label"] as const) {
      await db.execute(
        `update ${kind}s set renderable_track_count = 4, certified_finding_count = 2, latest_release_date = '2026-08-01'`,
      );
      expect(await walkIndexNowCatalogue({ kind })).toMatchObject({ changed: 1 });
    }
  });

  it("preserves first-observed lastmod proxies and ignores housekeeping writes", async () => {
    await seedCatalogue();
    await walkAll();
    const initial = await versions();
    expect(initial).toHaveLength(8);
    expect(initial.find((row) => row.kind === "artist")?.changed_at).toBe(ORIGINAL);
    expect(initial.find((row) => row.kind === "log")?.changed_at).toBe(ORIGINAL);
    expect(
      initial.find((row) => row.kind === "track" && row.subject_id === "000001")?.changed_at,
    ).toBe(OBSERVED);
    await ackIndexNowCatalogue((await claimIndexNowCatalogue()).items);
    const accepted = await versions();
    vi.setSystemTime("2026-10-06T00:00:00.000Z");
    await db.execute(
      "update tracks set capture_status = 'retry', catalogue_ranked_at = '2026-10-06', popularity = 100",
    );
    await db.execute(
      "update artists set image_attempted_at = '2026-10-06', updated_at = '2026-10-06', bio_prompt_version = 42",
    );
    await db.execute("update findings set spotify_error = 'Retry', updated_at = '2026-10-06'");
    await db.execute("update mixtapes set announced_at = '2026-10-06', updated_at = '2026-10-06'");
    await walkAll();
    expect(await versions()).toEqual(accepted);
    await db.execute("update tracks set title = 'Changed' where track_id = '000001'");
    await db.execute("update artists set bio = 'New bio'");
    await db.execute(
      "update albums set image_state = 'resolved',image_key = 'covers/album.jpg',image_updated_at = '2026-10-06'",
    );
    await db.execute("update labels set founding_date = '1995'");
    await db.execute("update findings set note = 'Visible finding note'");
    await walkAll();
    const updated = await versions();
    const due = updated.filter((row) => row.submitted_at === null);
    expect(due.map((row) => row.kind).sort((left, right) => left.localeCompare(right))).toEqual([
      "album",
      "artist",
      "label",
      "log",
      "track",
      "track",
      "track",
    ]);
    expect(due.every((row) => row.changed_at === "2026-10-06T00:00:00.000Z")).toBe(true);
  });

  it("observes finding artwork and links and published mixtape members", async () => {
    await seedCatalogue();
    await db.execute(
      "insert into mixtape_tracks (mixtape_id,track_id,finding_id,position,start_ms) values ('mix','000000','000000',0,0)",
    );
    await walkAll();
    await ackIndexNowCatalogue((await claimIndexNowCatalogue()).items);
    vi.setSystemTime("2026-10-06T00:00:00.000Z");
    await db.execute(
      "update tracks set album_image_url = 'https://example.com/new-cover.jpg' where track_id = '000000'",
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1, checked: 2 });
    await db.execute(
      "update tracks set title = 'Rendered tracklist title' where track_id = '000000'",
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 2 });
    await db.execute("update mixtape_tracks set start_ms = 1000 where mixtape_id = 'mix'");
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1 });
    await db.execute(
      "update findings set video_url = 'https://example.com/video.mp4', video_squared_at = '2026-07-02'",
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 1 });
    await db.execute(
      "update findings set updated_at = '2026-10-07', spotify_error = 'Another retry'",
    );
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ changed: 0 });
  });

  it("walks bounded keyset windows without skipping their boundary", async () => {
    await seedCatalogue(INDEXNOW_WINDOW_SIZE + 1);
    const executed = vi.spyOn(db, "execute");
    const started = performance.now();
    const first = await walkIndexNowCatalogue({ kind: "track" });
    const elapsed = performance.now() - started;
    expect(first).toMatchObject({
      changed: 0,
      checked: INDEXNOW_WINDOW_SIZE,
      inserted: INDEXNOW_WINDOW_SIZE,
      next: { after: "000999", kind: "track" },
    });
    expect(first.next).not.toBeNull();
    if (!first.next) {
      throw new Error("track window cursor missing");
    }
    expect(await walkIndexNowCatalogue(first.next)).toMatchObject({
      checked: 1,
      inserted: 1,
      next: null,
    });
    expect(await versions()).toHaveLength(INDEXNOW_WINDOW_SIZE + 1);
    const statement = executed.mock.calls[0]?.[0] as InStatement;
    const query = typeof statement === "string" ? { sql: statement } : statement;
    const result = await db.execute({ ...query, sql: `explain query plan ${query.sql}` });
    expect(
      result.rows.map((row) => (typeof row.detail === "string" ? row.detail : "")).join("\n"),
    ).toContain("track_id>?");
    console.log(
      `IndexNow integration window: ${first.checked} checked, ${first.inserted} inserted, ${elapsed.toFixed(1)}ms`,
    );
  });

  it("prunes gaps and final tails while preserving the cursor prefix and other kinds", async () => {
    await seedCatalogue(INDEXNOW_WINDOW_SIZE + 4);
    await db.execute("update tracks set dismissed_at = '2026-10-05' where track_id = '000050'");
    await db.batch(
      [
        ...["000000", "000001", "000050", "000500-orphan", "001004-orphan"].map((id) => ({
          args: [id, ORIGINAL],
          sql: "insert into search_page_versions (kind,subject_id,fingerprint,changed_at) values ('track',?,'preserved',?)",
        })),
        {
          args: [ORIGINAL],
          sql: "insert into search_page_versions (kind,subject_id,fingerprint,changed_at) values ('label','orphan','preserved',?)",
        },
      ],
      "write",
    );
    const first = await walkIndexNowCatalogue({ after: "000001", kind: "track" });
    expect(first).toMatchObject({
      checked: INDEXNOW_WINDOW_SIZE,
      next: { after: "001002", kind: "track" },
      removed: 2,
    });
    const afterFirst = await versions();
    for (const id of ["000000", "000001", "001004-orphan"]) {
      expect(
        afterFirst.find((row) => row.kind === "track" && row.subject_id === id)?.fingerprint,
      ).toBe("preserved");
    }
    if (!first.next) {
      throw new Error("track cursor missing");
    }
    expect(await walkIndexNowCatalogue(first.next)).toMatchObject({
      checked: 1,
      next: null,
      removed: 1,
    });
    expect(
      (await versions()).find((row) => row.kind === "label" && row.subject_id === "orphan"),
    ).toBeDefined();
    await db.execute({
      args: [ORIGINAL],
      sql: "insert into search_page_versions (kind,subject_id,fingerprint,changed_at) values ('track','tail','stale',?)",
    });
    expect(await walkIndexNowCatalogue({ after: "001003", kind: "track" })).toMatchObject({
      checked: 0,
      next: null,
      removed: 1,
    });
    expect((await versions()).filter((row) => row.kind === "track")).toHaveLength(
      INDEXNOW_WINDOW_SIZE + 3,
    );
  });
});

describe("catalogue claims and acknowledgements", () => {
  it("leaves versions due until a matching acknowledgement and uses the server clock", async () => {
    await seedCatalogue();
    await walkAll();
    const before = await versions();
    const claim = await claimIndexNowCatalogue(5);
    expect(claim.due).toBe(8);
    expect(claim.items).toHaveLength(5);
    const { host, key, keyLocation } = buildIndexNowPayload([]);
    expect(claim.indexNow).toEqual({ host, key, keyLocation });
    expect(claim.items.slice(0, 2).map((item) => item.url)).toEqual([
      "https://www.fluncle.com/log/001.0.0A",
      "https://www.fluncle.com/log/001.0.0B",
    ]);
    expect(await versions()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    vi.setSystemTime("2026-10-05T01:00:00.000Z");
    expect(await ackIndexNowCatalogue(claim.items)).toEqual({ due: 3, stamped: 5 });
    expect(
      (await versions())
        .filter((row) => row.submitted_at !== null)
        .every((row) => row.submitted_at === "2026-10-05T01:00:00.000Z"),
    ).toBe(true);
  });

  it("keeps unaccepted, concurrently changed, and departed versions due", async () => {
    await seedCatalogue();
    await walkAll();
    const claim = await claimIndexNowCatalogue();
    await db.execute(
      "update search_page_versions set fingerprint = 'concurrent' where kind = 'artist'",
    );
    await db.execute(
      "update search_page_versions set changed_at = '2026-10-05T00:00:01.000Z' where kind = 'label'",
    );
    await db.execute("delete from search_page_versions where kind = 'album'");
    expect(await ackIndexNowCatalogue(claim.items.filter((item) => item.kind !== "track"))).toEqual(
      { due: 5, stamped: 2 },
    );
    expect(
      (await versions()).filter((row) => row.submitted_at === null).map((row) => row.kind),
    ).toEqual(["artist", "label", "track", "track", "track"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains due versions when the acknowledgement write fails", async () => {
    await seedCatalogue();
    await walkAll();
    const claim = await claimIndexNowCatalogue();
    const before = await versions();
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("stamp unavailable"));
    await expect(ackIndexNowCatalogue(claim.items)).rejects.toThrow("stamp unavailable");
    expect(await versions()).toEqual(before);
  });

  it("claims exclude pages that left the sitemap without changing their versions", async () => {
    await seedCatalogue();
    await walkAll();
    await db.execute("update artists set renderable_track_count = 0");
    await db.execute("update tracks set dismissed_at = '2026-10-05' where track_id = '000001'");
    const before = await versions();
    const result = await claimIndexNowCatalogue();
    expect(result.due).toBe(8);
    expect(result.items).toHaveLength(6);
    expect(result.items.some((item) => item.kind === "artist" || item.subjectId === "000001")).toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await versions()).toEqual(before);
  });

  it("prunes departed subjects of every kind and counts due versions through the partial index", async () => {
    await seedCatalogue();
    await walkAll();
    await db.execute("update artists set renderable_track_count = 0");
    await db.execute("update albums set renderable_track_count = 0");
    await db.execute("update labels set renderable_track_count = 0");
    await db.execute("update tracks set dismissed_at = '2026-10-05' where track_id = '000001'");
    await db.execute("update findings set log_id = null");
    await db.execute("update mixtapes set status = 'draft'");
    const executed = vi.spyOn(db, "execute");
    const claim = await claimIndexNowCatalogue();
    expect(claim.due).toBe(8);
    expect(claim.items).toHaveLength(2);
    const statement = executed.mock.calls[1]?.[0] as InStatement;
    const query = typeof statement === "string" ? { sql: statement } : statement;
    const plan = await db.execute({ ...query, sql: `explain query plan ${query.sql}` });
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");
    expect(details).toContain("search_page_versions_due_idx");
    expect(details).not.toMatch(/CORRELATED|tracks|artists|albums|labels|findings|mixtapes/);
    expect(await walkIndexNowCatalogue({ kind: "log" })).toMatchObject({ checked: 0, removed: 2 });
    for (const kind of ["artist", "label", "album"] as const) {
      expect(await walkIndexNowCatalogue({ kind })).toMatchObject({ checked: 0, removed: 1 });
    }
    expect(await walkIndexNowCatalogue({ kind: "track" })).toMatchObject({
      checked: 2,
      removed: 1,
    });
    expect((await claimIndexNowCatalogue()).items).toHaveLength(2);
    const remaining = await versions();
    expect(remaining).toHaveLength(2);
    expect(remaining.every((row) => row.kind === "track")).toBe(true);
    await db.execute("update tracks set dismissed_at = '2026-10-05'");
    const empty = await claimIndexNowCatalogue();
    expect(empty.due).toBe(2);
    expect(empty.items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds claims to ten thousand newest URLs with logs ahead of the catalogue", async () => {
    await seedCatalogue();
    await db.batch(
      Array.from({ length: 10001 }, (_, index) => ({
        args: [
          `mix-${index}`,
          `log-${String(index).padStart(5, "0")}`,
          ORIGINAL,
          index % 2 === 0 ? ORIGINAL : OBSERVED,
          ORIGINAL,
        ],
        sql: "insert into mixtapes (id,title,log_id,status,created_at,updated_at,added_at) values (?,'Mix',?,'published',?,?,?)",
      })),
      "write",
    );
    await walkAll();
    const executed = vi.spyOn(db, "execute");
    const claim = await claimIndexNowCatalogue();
    expect(claim.due).toBe(10009);
    expect(claim.items).toHaveLength(10000);
    expect(claim.items.every((item) => item.kind === "log")).toBe(true);
    expect(claim.items[0]?.url).toBe("https://www.fluncle.com/log/log-00001");
    const statement = executed.mock.calls[0]?.[0] as InStatement;
    const query = typeof statement === "string" ? { sql: statement } : statement;
    const plan = await db.execute({ ...query, sql: `explain query plan ${query.sql}` });
    const details = plan.rows
      .map((row) => (typeof row.detail === "string" ? row.detail : ""))
      .join("\n");
    expect(details).toContain("search_page_versions_due_idx");
    expect(details).not.toContain("TEMP B-TREE FOR ORDER BY");
    expect(await ackIndexNowCatalogue(claim.items)).toEqual({ due: 9, stamped: 10000 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
