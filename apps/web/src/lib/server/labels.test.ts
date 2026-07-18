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
  confirmLabelAlias,
  ensureLabel,
  getConfirmedAliasNames,
  isDistributorLabel,
  labelSlug,
  LabelNotFoundError,
  letterPages,
  listLabelAliasCandidates,
  listLabelReviewRows,
  listLabels,
  reconcileLabels,
  rejectLabelAlias,
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

describe("ensureLabel — the MusicBrainz label MBID fold (the discovered-label fold key)", () => {
  async function mbLabelIdOf(slug: string): Promise<null | string> {
    const result = await db.execute({
      args: [slug],
      sql: `select mb_label_id from labels where slug = ?`,
    });

    return (result.rows[0]?.mb_label_id as null | string) ?? null;
  }

  it("mints a discovered label and stamps the MBID it folds on", async () => {
    const id = await ensureLabel("Med School", "mbid-medschool");

    expect(id).toBeDefined();
    expect(await labelSlugs()).toEqual(["med-school"]);
    expect(await mbLabelIdOf("med-school")).toBe("mbid-medschool");
  });

  it("collapses two spellings that slugify apart onto ONE row when they share an MBID", async () => {
    // "Med School" → med-school, "Medschool" → medschool: two distinct slugs, one label. The MBID
    // is what folds them — without it these mint as two rows (the bug this slice fixes).
    const first = await ensureLabel("Med School", "mbid-medschool");
    const second = await ensureLabel("Medschool", "mbid-medschool");

    expect(second).toBe(first);
    // Only the FIRST spelling's row exists; the second resolved to it by MBID and minted nothing.
    expect(await labelSlugs()).toEqual(["med-school"]);
  });

  it("resolves by MBID first — reusing the row whatever spelling the caller passes", async () => {
    const id = await ensureLabel("Med School", "mbid-medschool");

    // A totally different display string, same MBID → the same row, no new mint.
    const again = await ensureLabel("MedSchool Recordings UK", "mbid-medschool");

    expect(again).toBe(id);
    expect(await listLabels()).toHaveLength(1);
  });

  it("ADOPTS the MBID onto a pre-existing slug row that has none (fill-empty-only)", async () => {
    // A publish minted the label first, no MBID. The crawler later walks it and carries the MBID.
    const minted = await ensureLabel("Shogun Audio");
    expect(await mbLabelIdOf("shogun-audio")).toBeNull();

    const folded = await ensureLabel("Shogun Audio", "mbid-shogun");

    expect(folded).toBe(minted);
    expect(await mbLabelIdOf("shogun-audio")).toBe("mbid-shogun");
    expect(await listLabels()).toHaveLength(1);
  });

  it("never rewrites an MBID already on the row (a different MBID for the same slug is ignored)", async () => {
    await ensureLabel("Critical Music", "mbid-critical");

    // A second, conflicting MBID for the same slug must not clobber the first — fill-empty-only.
    await ensureLabel("Critical Music", "mbid-imposter");

    expect(await mbLabelIdOf("critical-music")).toBe("mbid-critical");
    expect(await listLabels()).toHaveLength(1);
  });

  it("FALLBACK: no MBID still folds by slug, and stores a NULL MBID", async () => {
    const first = await ensureLabel("Hospital Records");
    const again = await ensureLabel("Hospital Records");

    expect(again).toBe(first);
    expect(await mbLabelIdOf("hospital-records")).toBeNull();
    expect(await listLabels()).toHaveLength(1);
  });

  it("FALLBACK: a confirmed alias still folds when no MBID resolves it", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      labelId: "lbl_med",
      status: "confirmed",
    });

    // No MBID passed — the alias path resolves the folded-away spelling to the canonical label.
    const id = await ensureLabel("Med School Recordings");

    expect(id).toBe("lbl_med");
    expect(await labelSlugs()).toEqual(["medschool"]);
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

// ── LABEL ALIASES: two spellings, one label (RFC musickit-second-authority, U2a) ────────────

/** Insert a canonical `labels` row directly (the merge target an alias points at). */
async function insertLabel(id: string, name: string, slug: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [id, name, slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

/** Insert a `label_aliases` row (defaults: an Apple `name` candidate). */
async function insertAlias(opts: {
  alias: string;
  aliasSlug: string;
  id: string;
  kind?: "hint" | "name";
  labelId: string;
  source?: string;
  status: "candidate" | "confirmed";
}): Promise<void> {
  await db.execute({
    args: [
      opts.id,
      opts.labelId,
      opts.alias,
      opts.aliasSlug,
      opts.source ?? "apple",
      opts.kind ?? "name",
      opts.status,
      new Date().toISOString(),
    ],
    sql: `insert into label_aliases
            (id, label_id, alias, alias_slug, source, kind, status, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function labelSlugs(): Promise<string[]> {
  const result = await db.execute(`select slug from labels order by slug`);
  return result.rows.map((row) => row.slug as string);
}

describe("isDistributorLabel (the panel's denylist guardrail)", () => {
  it("matches a seeded distributor by fold, and never a real imprint", () => {
    expect(isDistributorLabel("Believe")).toBe(true);
    expect(isDistributorLabel("the orchard")).toBe(true); // folded, case-insensitive
    expect(isDistributorLabel("Horus Music")).toBe(true);
    expect(isDistributorLabel("Medschool")).toBe(false);
    expect(isDistributorLabel("Hospital Records")).toBe(false);
    expect(isDistributorLabel(null)).toBe(false);
  });
});

describe("the re-mint trap (a confirmed alias's raw string must not re-mint its slug)", () => {
  // The trap, reproduced: the operator has folded "Med School Recordings" into "Medschool" via a
  // CONFIRMED alias, but `tracks.label` is immutable and still carries the raw string. Without the
  // guard, reconcile/ensureLabel would mint a fresh `med-school-recordings` label every deploy —
  // re-opening the split forever.
  async function seedFoldedAwaySpelling(): Promise<void> {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      labelId: "lbl_med",
      status: "confirmed",
    });
    await seedFinding("t1", "Med School Recordings");
  }

  it("PROOF the trap is real: a NON-aliased raw string DOES re-mint on reconcile", async () => {
    await seedFinding("t1", "Med School Recordings");

    await reconcileLabels();

    // No alias exists, so the raw string mints its own slug — this is exactly what a confirmed
    // alias must prevent.
    expect(await labelSlugs()).toContain("med-school-recordings");
  });

  it("reconcileLabels never re-mints a confirmed alias's slug", async () => {
    await seedFoldedAwaySpelling();

    const minted = await reconcileLabels();

    expect(minted).toBe(0);
    // The only label is the canonical one; the folded-away slug was NOT re-minted.
    expect(await labelSlugs()).toEqual(["medschool"]);
  });

  it("ensureLabel resolves a confirmed alias's raw string to the canonical label, minting nothing", async () => {
    await seedFoldedAwaySpelling();

    // This is ALSO the crawler's discovery choke point — `crawl.ts` calls `ensureLabel` on a
    // discovered label, so the crawl path is covered by the same guard.
    const id = await ensureLabel("Med School Recordings");

    expect(id).toBe("lbl_med");
    expect(await labelSlugs()).toEqual(["medschool"]);
  });

  it("the deploy backfill (backfillLabels) never re-mints, and links the raw string to the canonical label", async () => {
    await seedFoldedAwaySpelling();

    await backfillLabels(db);

    // The canonical label is the only med* row.
    expect(await labelSlugs()).toEqual(["medschool"]);
    // The track carrying the folded-away spelling points at the CANONICAL label, via the alias.
    const track = await db.execute(`select label_id from tracks where track_id = 't1'`);
    expect(track.rows[0]?.label_id).toBe("lbl_med");
  });

  it("a CANDIDATE (unconfirmed) alias does NOT protect its slug — only a confirmed one folds in", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      labelId: "lbl_med",
      status: "candidate",
    });
    await seedFinding("t1", "Med School Recordings");

    await reconcileLabels();

    // Unconfirmed ⇒ no protection ⇒ the raw string mints (the operator hasn't ruled yet).
    expect(await labelSlugs()).toContain("med-school-recordings");
  });
});

describe("the alias review reads + operator writes", () => {
  it("getConfirmedAliasNames returns only confirmed aliases, name-sorted", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      labelId: "lbl_med",
      status: "confirmed",
    });
    await insertAlias({
      alias: "Med School",
      aliasSlug: "med-school",
      id: "lba_2",
      labelId: "lbl_med",
      status: "confirmed",
    });
    await insertAlias({
      alias: "Medschool Music",
      aliasSlug: "medschool-music",
      id: "lba_3",
      labelId: "lbl_med",
      status: "candidate",
    });

    expect(await getConfirmedAliasNames("lbl_med")).toEqual([
      "Med School",
      "Med School Recordings",
    ]);
    expect(await getConfirmedAliasNames("nope")).toEqual([]);
  });

  it("listLabelAliasCandidates returns open candidates joined to their label", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      kind: "name",
      labelId: "lbl_med",
      status: "candidate",
    });
    await insertAlias({
      alias: "Confirmed One",
      aliasSlug: "confirmed-one",
      id: "lba_2",
      labelId: "lbl_med",
      status: "confirmed",
    });

    const candidates = await listLabelAliasCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      alias: "Med School Recordings",
      kind: "name",
      labelName: "Medschool",
      labelSlug: "medschool",
      source: "apple",
    });
  });

  it("confirmLabelAlias promotes a candidate; rejectLabelAlias deletes it; both idempotent", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlias({
      alias: "Med School Recordings",
      aliasSlug: "med-school-recordings",
      id: "lba_1",
      labelId: "lbl_med",
      status: "candidate",
    });
    await insertAlias({
      alias: "Med School",
      aliasSlug: "med-school",
      id: "lba_2",
      labelId: "lbl_med",
      status: "candidate",
    });

    expect(await confirmLabelAlias("lba_1")).toBe(true);
    expect(await confirmLabelAlias("lba_1")).toBe(false); // already confirmed — no-op
    expect(await getConfirmedAliasNames("lbl_med")).toEqual(["Med School Recordings"]);

    expect(await rejectLabelAlias("lba_2")).toBe(true);
    expect(await rejectLabelAlias("lba_2")).toBe(false); // gone — no-op
    // The confirmed one survives; only the rejected candidate is gone.
    expect(await listLabelAliasCandidates()).toHaveLength(0);
  });
});

// The A–Z fast lane's page math: per-first-char counts (slug-ordered) fold to one page number per
// DISPLAY letter, so a crawler clicking "M" lands on the page its first M-entity really is on.
describe("letterPages (the A–Z lane's page math)", () => {
  it("maps each letter to the page its first entity lands on, at the given page size", () => {
    // Page size 3: a(3) fills page 1, b(2)+c(1) fill page 2, d(3) fills page 3.
    const pages = letterPages(
      [
        { letter: "a", n: 3 },
        { letter: "b", n: 2 },
        { letter: "c", n: 1 },
        { letter: "d", n: 3 },
      ],
      3,
    );

    expect(pages).toEqual([
      { letter: "a", page: 1 },
      { letter: "b", page: 2 },
      { letter: "c", page: 2 },
      { letter: "d", page: 3 },
    ]);
  });

  it("folds digit-led slugs into a single '#' bucket, keeping its earliest page", () => {
    // Digits sort before letters, so the "#" bucket is contiguous at the front (rank 0 ⇒ page 1).
    const pages = letterPages(
      [
        { letter: "0", n: 1 },
        { letter: "9", n: 1 },
        { letter: "a", n: 1 },
      ],
      10,
    );

    expect(pages).toEqual([
      { letter: "#", page: 1 },
      { letter: "a", page: 1 },
    ]);
  });

  it("is empty for an empty hub", () => {
    expect(letterPages([], 48)).toEqual([]);
  });
});
