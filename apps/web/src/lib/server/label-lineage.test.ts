// The label-lineage resolve sweep (RFC label-lineage-remixer U1), proven against the REAL migrated
// schema on an in-memory libSQL engine (the labels.test.ts harness): `getDb` is mocked to hand back
// a fresh `:memory:` client with every generated migration applied, so the REAL `label-lineage.ts`
// SQL runs against the REAL schema — which also means a placeholder/arg MISMATCH throws for real
// (the arity guard, stronger than a mock could give; the recording-wrapper test below pins it
// explicitly too). The MusicBrainz client (`mbFetch`) is mocked, so no test hits the network.

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

// Records every {sql, args} the sweep issues, so one test can pin placeholder-count == arg-count
// across a full wet pass (the recording-mbids.test.ts arity guard, applied to real execution).
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

/** A MusicBrainz label lookup response for one label (life-span + area + backward parent rels). */
function lineageResponse(opts: {
  begin?: string;
  areaName?: string;
  parentMbids?: Array<{ id: string; type?: string; direction?: string }>;
}) {
  return {
    data: {
      area: opts.areaName ? { name: opts.areaName } : undefined,
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

  // Wrap execute so the arity guard test can inspect every statement the sweep runs (real SQL still
  // executes underneath, so a mismatch also throws for real).
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
    // Never minted a label for the unmatched parent.
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
    mbFetch.mockResolvedValue({ data: { labels: [] }, rateLimited: false }); // search miss

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
    // Untouched — still pending, so the next tick retries it fresh.
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
    // Three eligible labels with stored MBIDs (one mbFetch each). The Date.now spy jumps 70s per
    // vendor call — past the 60s response budget after the FIRST label — modelling the shared
    // MusicBrainz chain congested by another sweep. The pass must hand back what it finished plus
    // a cursor, never run the client into its fetch timeout.
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
      // Resume right after the last handled label — the CLI's drain loop re-requests from here.
      expect(result.nextCursor).toBe("alpha");

      // The paused tail carries NO attempt stamp, so the resumed request is not cooldown-blocked.
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

// THE ARITY GUARD (the recording-mbids.test.ts pattern): every statement the sweep issues must bind
// exactly as many args as it declares placeholders. Real SQL execution already throws on a
// mismatch, but this pins it explicitly across a full wet pass (strip + worklist + resolved + none
// + failure writes). None of the sweep's SQL carries a literal '?', so the count is exact.
describe("every statement binds exactly its placeholders", () => {
  it("holds across a full wet pass (resolved + unmatched + none + failure)", async () => {
    await seedLabel({
      lineageState: "resolved",
      mbLabelId: "mb-p",
      name: "Parent",
      slug: "parent",
    });
    await seedLabel({ mbLabelId: "mb-a", name: "Alpha", slug: "alpha" });
    await seedLabel({ name: "Bravo", slug: "bravo" }); // no MBID → search
    await seedLabel({ mbLabelId: "mb-c", name: "Charlie", slug: "charlie" });

    mbFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/label?query=")) {
        return { data: { labels: [] }, rateLimited: false }; // Bravo misses → none
      }
      if (url.includes("mb-a")) {
        return lineageResponse({ begin: "2001", parentMbids: [{ id: "mb-p" }] }); // matched parent
      }
      if (url.includes("mb-c")) {
        return lineageResponse({ begin: "2002", parentMbids: [{ id: "mb-none" }] }); // unmatched
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
