// The label entity + the operator's crawl-seed control, proven against the REAL migrated
// schema on an in-memory libSQL engine (vitest env = node). `getDb` is mocked to hand back
// the per-test client, so the real SQL in labels.ts runs against the real DDL.
//
// The load-bearing guarantee under test is the one the whole design rests on: RULING IS
// CRAWL SCOPE, NEVER STORAGE. Disabling a label must leave every track, every finding, and
// every stored row exactly as it found them. There is a test that asserts precisely that.
import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillLabels } from "../../../scripts/backfill-labels";
import { createIntegrationDb } from "./integration-db";
import {
  ensureLabel,
  labelSlug,
  LabelNotFoundError,
  listLabelReviewRows,
  listLabels,
  reconcileLabels,
  updateLabelSeedState,
} from "./labels";

let db: Client;

/** A finding carrying a raw label string — the only way a label enters the archive. */
async function seedFinding(trackId: string, label: null | string): Promise<void> {
  // The label is the RECORDING's; the coordinate + found date are the CERTIFICATION's.
  // Both halves, because `listLabels` counts FINDINGS on a label (it joins through).
  await db.execute({
    args: [trackId, "Tune", '["Artist"]', label],
    sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label)
          values (?, ?, ?, 'uri', 'url', 0, ?)`,
  });
  await db.execute({
    args: [trackId, `00${trackId}`, "2026-07-01T00:00:00.000Z"],
    sql: `insert into findings
            (track_id, log_id, added_at, added_to_spotify, posted_to_telegram)
          values (?, ?, ?, 0, 0)`,
  });
}

async function seedStateOf(slug: string): Promise<string | undefined> {
  const result = await db.execute({
    args: [slug],
    sql: `select seed_state from labels where slug = ?`,
  });

  return result.rows[0]?.seed_state as string | undefined;
}

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;
});

describe("labelSlug (the identity + the join key)", () => {
  it("folds spelling variants of the same label onto one slug", () => {
    expect(labelSlug("Pilot.")).toBe("pilot");
    expect(labelSlug("Pilot")).toBe("pilot");
    expect(labelSlug("  Hospital Records ")).toBe("hospital-records");
    expect(labelSlug("R.O.A.M")).toBe("r-o-a-m");
  });

  it("mints nothing from a blank or all-punctuation label", () => {
    expect(labelSlug("")).toBeUndefined();
    expect(labelSlug("   ")).toBeUndefined();
    expect(labelSlug("...")).toBeUndefined();
    expect(labelSlug(null)).toBeUndefined();
    expect(labelSlug(undefined)).toBeUndefined();
  });
});

describe("ensureLabel (the publish path's upsert)", () => {
  it("enters a brand-new label as undecided — never silently crawled, never silently dropped", async () => {
    await ensureLabel("Hoofbeats Music");

    const labels = await listLabels();

    expect(labels).toHaveLength(1);
    expect(labels[0]?.name).toBe("Hoofbeats Music");
    expect(labels[0]?.slug).toBe("hoofbeats-music");
    expect(labels[0]?.seedState).toBe("undecided");
    expect(labels[0]?.ruledAt).toBeNull();
  });

  it("never clobbers an existing ruling (a second finding on a ruled label is a no-op)", async () => {
    await ensureLabel("Shogun Audio");
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }
    await updateLabelSeedState(label.id, "disabled");

    await ensureLabel("Shogun Audio");

    expect(await seedStateOf("shogun-audio")).toBe("disabled");
    expect(await listLabels()).toHaveLength(1);
  });

  it("mints nothing for a blank label", async () => {
    await ensureLabel(null);
    await ensureLabel("   ");

    expect(await listLabels()).toHaveLength(0);
  });
});

describe("reconcileLabels (the deterministic backstop)", () => {
  it("mints a row for every distinct label, folding spelling variants", async () => {
    await seedFinding("t1", "Pilot.");
    await seedFinding("t2", "Pilot");
    await seedFinding("t3", "Hospital Records");
    await seedFinding("t4", null);

    expect(await reconcileLabels()).toBe(2);

    const labels = await listLabels();

    expect(labels.map((label) => label.slug).sort()).toEqual(["hospital-records", "pilot"]);
    // Both spellings count toward the one label — the count is DERIVED, never stored.
    expect(labels.find((label) => label.slug === "pilot")?.findingCount).toBe(2);
    expect(labels.find((label) => label.slug === "hospital-records")?.findingCount).toBe(1);
  });

  it("is idempotent — a second run mints nothing and changes nothing", async () => {
    await seedFinding("t1", "Liquid Tones");
    await reconcileLabels();
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }
    await updateLabelSeedState(label.id, "enabled");

    expect(await reconcileLabels()).toBe(0);

    const after = await listLabels();
    expect(after).toHaveLength(1);
    expect(after[0]?.seedState).toBe("enabled");
    expect(after[0]?.id).toBe(label.id);
  });
});

describe("updateLabelSeedState (the operator's ruling)", () => {
  it("stamps ruledAt so the one-time bootstrap can never overwrite an operator's call", async () => {
    await ensureLabel("UKF");
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    const ruled = await updateLabelSeedState(label.id, "disabled");

    expect(ruled.seedState).toBe("disabled");
    expect(ruled.ruledAt).not.toBeNull();
  });

  it("404s on an id that is not there", async () => {
    await expect(updateLabelSeedState("lbl_nope", "enabled")).rejects.toBeInstanceOf(
      LabelNotFoundError,
    );
  });

  // THE GUARANTEE. Crawl scope, never storage: ruling a label off changes the next crawl's
  // seed set and touches NOTHING already stored. If this ever fails, the whole control is
  // unsafe and the operator can no longer trust it.
  it("touches nothing already stored — the finding on a disabled label is untouched", async () => {
    await seedFinding("t1", "Anjunabeats");
    await reconcileLabels();
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    const before = await db.execute(`select * from tracks order by track_id`);

    await updateLabelSeedState(label.id, "disabled");

    const after = await db.execute(`select * from tracks order by track_id`);

    expect(after.rows).toEqual(before.rows);
    // And the finding still counts toward its label: disabling hides nothing.
    expect((await listLabels())[0]?.findingCount).toBe(1);
  });
});

describe("listLabels (the read, and the crawler's seed set)", () => {
  it("scopes to one seed state — `enabled` is exactly the seed set the crawler will read", async () => {
    await seedFinding("t1", "Hospital Records");
    await seedFinding("t2", "Anjunabeats");
    await seedFinding("t3", "Chelou");
    await reconcileLabels();

    for (const label of await listLabels()) {
      if (label.slug === "hospital-records") {
        await updateLabelSeedState(label.id, "enabled");
      } else if (label.slug === "anjunabeats") {
        await updateLabelSeedState(label.id, "disabled");
      }
    }

    expect((await listLabels("enabled")).map((label) => label.slug)).toEqual(["hospital-records"]);
    expect((await listLabels("disabled")).map((label) => label.slug)).toEqual(["anjunabeats"]);
    expect((await listLabels("undecided")).map((label) => label.slug)).toEqual(["chelou"]);
  });

  it("surfaces the label's own logo when a resolved image_key exists, undefined otherwise", async () => {
    await seedFinding("t1", "Hospital Records");
    await seedFinding("t2", "Anjunabeats");
    await reconcileLabels();
    await db.execute({
      args: ["labels/hospital-records.jpg", "hospital-records"],
      sql: `update labels set image_key = ?, image_state = 'resolved' where slug = ?`,
    });

    const bySlug = new Map((await listLabels()).map((label) => [label.slug, label]));

    expect(bySlug.get("hospital-records")?.logoImageUrl).toBe(
      "https://found.fluncle.com/labels/hospital-records.jpg",
    );
    expect(bySlug.get("anjunabeats")?.logoImageUrl).toBeUndefined();
  });
});

describe("listLabelReviewRows (the attention-queue source)", () => {
  it("surfaces only the unruled labels, oldest first", async () => {
    await ensureLabel("Alpha Records");
    await ensureLabel("Beta Records");
    const labels = await listLabels();
    const alpha = labels.find((label) => label.slug === "alpha-records");
    expect(alpha).toBeDefined();
    if (!alpha) {
      return;
    }
    await updateLabelSeedState(alpha.id, "enabled");

    const rows = await listLabelReviewRows();

    expect(rows.map((row) => row.name)).toEqual(["Beta Records"]);
  });
});

describe("the D7 bootstrap (scripts/backfill-labels.ts)", () => {
  it("reconciles, applies the starting ruling, and never runs a second time", async () => {
    await seedFinding("t1", "Hospital Records");
    await seedFinding("t2", "Anjunabeats");
    await seedFinding("t3", "Zerothree");
    await seedFinding("t4", "spiration music");
    await seedFinding("t5", "UKF");
    await seedFinding("t6", "Chelou");

    const first = await backfillLabels(db);

    expect(first.bootstrapped).toBe(true);
    expect(first.minted).toBe(6);
    expect(await seedStateOf("hospital-records")).toBe("enabled");
    expect(await seedStateOf("anjunabeats")).toBe("disabled");
    expect(await seedStateOf("zerothree")).toBe("disabled");
    expect(await seedStateOf("spiration-music")).toBe("undecided");
    expect(await seedStateOf("ukf")).toBe("undecided");
    expect(await seedStateOf("chelou")).toBe("undecided");

    // The bootstrap is a ONE-TIME data step: a label added afterwards enters `undecided`
    // and waits for a human, rather than being auto-enabled by the seed's "everything else".
    await seedFinding("t7", "Some New Imprint");

    const second = await backfillLabels(db);

    expect(second.bootstrapped).toBe(false);
    expect(second.minted).toBe(1);
    expect(await seedStateOf("some-new-imprint")).toBe("undecided");
  });

  it("never clobbers an operator ruling", async () => {
    await seedFinding("t1", "Anjunabeats");
    await reconcileLabels();
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }
    // The operator overrules the RFC's starting call BEFORE the bootstrap ever runs.
    await updateLabelSeedState(label.id, "enabled");

    await backfillLabels(db);

    expect(await seedStateOf("anjunabeats")).toBe("enabled");
  });

  it("writes the label_id graph pointer and NOTHING else on a track", async () => {
    await seedFinding("t1", "Anjunabeats");
    const before = await db.execute(`select * from tracks order by track_id`);

    await backfillLabels(db);

    const after = await db.execute(`select * from tracks order by track_id`);

    // The backfill stamps ONE column on `tracks`: `label_id`, the indexed edge the public
    // /label/<slug> page reads by (schema.ts). It is a POINTER, never a ruling — it says
    // where this track sits in the graph, and nothing about what the crawler may seed from.
    // Every other column, including the raw `label` audit string, comes out byte-identical.
    const strip = (rows: typeof before.rows) =>
      rows.map((row) => {
        const { label_id: _labelId, ...rest } = row as Record<string, unknown>;

        return rest;
      });

    expect(strip(after.rows)).toEqual(strip(before.rows));
    expect(before.rows[0]?.label_id).toBeNull();
    expect(after.rows[0]?.label_id).toEqual(expect.stringMatching(/^lbl_/));
  });

  // The guarantee the whole design rests on is one line up (`updateLabelSeedState` → the
  // tracks table byte-identical, line ~178). The backfill's pointer write does not touch it:
  // a RULING still changes nothing that is stored.
});
