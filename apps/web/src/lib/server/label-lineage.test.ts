import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const mbFetch = vi.hoisted(() => vi.fn());

vi.mock("./musicbrainz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicbrainz")>();

  return { ...actual, mbFetch };
});

import { createIntegrationDb } from "./integration-db";
import { resolveLabelLineage } from "./label-lineage";

let db: Client;

const executeCalls: Array<{ argc: number; sql: string }> = [];

async function seedLabel(opts: {
  lineageState?: string;
  mbLabelId?: string;
  name: string;
  parentLabelId?: string;
  slug: string;
}): Promise<string> {
  const id = `lbl_${opts.slug}`;
  const now = new Date().toISOString();

  await db.execute({
    args: [
      id,
      opts.name,
      opts.slug,
      opts.mbLabelId ?? null,
      opts.parentLabelId ?? null,
      opts.lineageState ?? "pending",
      now,
      now,
    ],
    sql: `insert into labels
            (id, name, slug, mb_label_id, parent_label_id, lineage_state, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return id;
}

async function labelRow(slug: string): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute({ args: [slug], sql: `select * from labels where slug = ?` });

  return result.rows[0] as Record<string, unknown> | undefined;
}

function lineageResponse(opts: {
  begin?: string;
  areaName?: string;

  disambiguation?: string;
  parentMbids?: Array<{ id: string; type?: string; direction?: string }>;
}) {
  return {
    data: {
      area: opts.areaName ? { name: opts.areaName } : undefined,
      disambiguation: opts.disambiguation,
      "life-span": opts.begin ? { begin: opts.begin } : undefined,
      relations: (opts.parentMbids ?? []).map((parent) => ({
        direction: parent.direction ?? "backward",
        label: { id: parent.id },
        type: parent.type ?? "label ownership",
      })),
    },
    rateLimited: false,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();

  executeCalls.length = 0;
  const original = db.execute.bind(db);
  db.execute = ((stmt: unknown) => {
    if (stmt && typeof stmt === "object" && "sql" in stmt) {
      const detailed = stmt as { args?: unknown[]; sql: string };
      executeCalls.push({
        argc: Array.isArray(detailed.args) ? detailed.args.length : 0,
        sql: detailed.sql,
      });
    }

    return original(stmt as Parameters<Client["execute"]>[0]);
  }) as Client["execute"];

  holder.db = db;
  mbFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveLabelLineage", () => {
  it("writes founding date + place and matches a parent already in the archive by MBID", async () => {
    const parentId = await seedLabel({
      lineageState: "resolved",
      mbLabelId: "mb-hospital",
      name: "Hospital Records",
      slug: "hospital-records",
    });
    await seedLabel({ mbLabelId: "mb-med", name: "Med School", slug: "med-school" });

    mbFetch.mockImplementation(async (url: string) => {
      if (url.includes("mb-med")) {
        return lineageResponse({
          areaName: "United Kingdom",
          begin: "2006",
          parentMbids: [{ id: "mb-hospital", type: "label ownership" }],
        });
      }

      return { data: {}, rateLimited: false };
    });

    const result = await resolveLabelLineage(10, false);

    expect(result.resolved).toContain("med-school");
    expect(result.unmatchedParents).toBe(0);

    const row = await labelRow("med-school");
    expect(row?.["founding_date"]).toBe("2006");
    expect(row?.["founded_location"]).toBe("United Kingdom");
    expect(row?.["parent_label_id"]).toBe(parentId);
    expect(row?.["lineage_state"]).toBe("resolved");
  });

  it("persists the MusicBrainz disambiguation comment alongside the founding facts", async () => {
    await seedLabel({ mbLabelId: "mb-helix", name: "Helix", slug: "helix" });
    mbFetch.mockResolvedValue(
      lineageResponse({
        areaName: "London",
        begin: "2011",
        disambiguation: "  UK drum & bass label  ",
      }),
    );

    await resolveLabelLineage(10, false);

    const row = await labelRow("helix");
    expect(row?.["disambiguation"]).toBe("UK drum & bass label");
    expect(row?.["founding_date"]).toBe("2011");
  });

  it("stores nothing for the empty comment MusicBrainz sends by default", async () => {
    await seedLabel({ mbLabelId: "mb-plain", name: "Plain Imprint", slug: "plain-imprint" });
    mbFetch.mockResolvedValue(lineageResponse({ begin: "2019", disambiguation: "" }));

    await resolveLabelLineage(10, false);

    expect((await labelRow("plain-imprint"))?.["disambiguation"]).toBeNull();
  });

  it("never clobbers a disambiguation already on the row", async () => {
    await seedLabel({ mbLabelId: "mb-kept", name: "Kept", slug: "kept" });
    await db.execute({
      args: ["the operator's own note", "kept"],
      sql: `update labels set disambiguation = ? where slug = ?`,
    });
    mbFetch.mockResolvedValue(lineageResponse({ disambiguation: "something else entirely" }));

    await resolveLabelLineage(10, false);

    expect((await labelRow("kept"))?.["disambiguation"]).toBe("the operator's own note");
  });

  it("counts a parent MusicBrainz names but the archive lacks (never mints it)", async () => {
    await seedLabel({ mbLabelId: "mb-child", name: "Child Label", slug: "child-label" });

    mbFetch.mockResolvedValue(
      lineageResponse({ begin: "2010", parentMbids: [{ id: "mb-nobody-has-this" }] }),
    );

    const before = await db.execute(`select count(*) as n from labels`);
    const result = await resolveLabelLineage(10, false);
    const after = await db.execute(`select count(*) as n from labels`);

    expect(result.unmatchedParents).toBe(1);
    expect((await labelRow("child-label"))?.["parent_label_id"]).toBeNull();

    expect(after.rows[0]?.["n"]).toBe(before.rows[0]?.["n"]);
  });

  it("resolves the MBID by exact-fold search when the label has none, then walks its lineage", async () => {
    await seedLabel({ name: "Exact Name", slug: "exact-name" });

    mbFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/label?query=")) {
        return { data: { labels: [{ id: "mb-found", name: "Exact Name" }] }, rateLimited: false };
      }

      return lineageResponse({ begin: "1999" });
    });

    const result = await resolveLabelLineage(10, false);

    expect(result.resolved).toContain("exact-name");
    const row = await labelRow("exact-name");
    expect(row?.["mb_label_id"]).toBe("mb-found");
    expect(row?.["founding_date"]).toBe("1999");
  });

  it("marks a label with no MusicBrainz identity as terminal none", async () => {
    await seedLabel({ name: "Unknown Bedroom Imprint", slug: "unknown-bedroom-imprint" });
    mbFetch.mockResolvedValue({ data: { labels: [] }, rateLimited: false });

    const result = await resolveLabelLineage(10, false);

    expect(result.none).toContain("unknown-bedroom-imprint");
    expect((await labelRow("unknown-bedroom-imprint"))?.["lineage_state"]).toBe("none");
  });

  it("circuit-breaks on a MusicBrainz throttle without stamping the label", async () => {
    await seedLabel({ mbLabelId: "mb-throttled", name: "Throttled", slug: "throttled" });
    mbFetch.mockResolvedValue({ data: null, rateLimited: true });

    const result = await resolveLabelLineage(10, false);

    expect(result.rateLimited).toBe(true);
    expect(result.resolvedCount).toBe(0);

    expect((await labelRow("throttled"))?.["lineage_state"]).toBe("pending");
  });

  it("backs a failed label off (records a failure, leaves it pending)", async () => {
    await seedLabel({ mbLabelId: "mb-boom", name: "Boom", slug: "boom" });
    mbFetch.mockRejectedValue(new Error("network boom"));

    const result = await resolveLabelLineage(10, false);

    expect(result.failedCount).toBe(1);
    const row = await labelRow("boom");
    expect(row?.["lineage_failures"]).toBe(1);
    expect(row?.["lineage_state"]).toBe("pending");
  });

  it("pauses on the spent response budget with a resume cursor, leaving the unwalked tail unstamped", async () => {
    await seedLabel({ mbLabelId: "mb-a", name: "Alpha", slug: "alpha" });
    await seedLabel({ mbLabelId: "mb-b", name: "Bravo", slug: "bravo" });
    await seedLabel({ mbLabelId: "mb-c", name: "Charlie", slug: "charlie" });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      mbFetch.mockImplementation(async () => {
        now += 70_000;

        return lineageResponse({ begin: "1994" });
      });

      const result = await resolveLabelLineage(10, false);

      expect(result.resolved).toEqual(["alpha"]);
      expect(result.rateLimited).toBe(false);

      expect(result.nextCursor).toBe("alpha");

      for (const slug of ["bravo", "charlie"]) {
        const row = await labelRow(slug);
        expect(row?.["lineage_state"]).toBe("pending");
        expect(row?.["lineage_attempted_at"]).toBeNull();
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a dry run reports the worklist and touches no vendor or write", async () => {
    await seedLabel({ mbLabelId: "mb-dry", name: "Dry", slug: "dry" });

    const result = await resolveLabelLineage(10, true);

    expect(result.dryRun).toBe(true);
    expect(result.resolved).toContain("dry");
    expect(mbFetch).not.toHaveBeenCalled();
    expect((await labelRow("dry"))?.["lineage_state"]).toBe("pending");
  });
});

describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (resolved + unmatched + none + failure)", async () => {
    await seedLabel({
      lineageState: "resolved",
      mbLabelId: "mb-p",
      name: "Parent",
      slug: "parent",
    });
    await seedLabel({ mbLabelId: "mb-a", name: "Alpha", slug: "alpha" });
    await seedLabel({ name: "Bravo", slug: "bravo" });
    await seedLabel({ mbLabelId: "mb-c", name: "Charlie", slug: "charlie" });

    mbFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/label?query=")) {
        return { data: { labels: [] }, rateLimited: false };
      }
      if (url.includes("mb-a")) {
        return lineageResponse({ begin: "2001", parentMbids: [{ id: "mb-p" }] });
      }
      if (url.includes("mb-c")) {
        return lineageResponse({ begin: "2002", parentMbids: [{ id: "mb-none" }] });
      }

      return { data: {}, rateLimited: false };
    });

    await resolveLabelLineage(10, false);

    expect(executeCalls.length).toBeGreaterThan(0);

    for (const call of executeCalls) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;

      expect({ argc: call.argc, placeholders, sql: call.sql.slice(0, 50) }).toMatchObject({
        argc: placeholders,
        placeholders,
      });
    }
  });
});
