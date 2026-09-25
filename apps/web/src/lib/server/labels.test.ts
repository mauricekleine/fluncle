import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

import { backfillLabels, linkTracksToLabels } from "../../../scripts/backfill-labels";
import {
  initializePublicProjectionTestState,
  readPublicProjectionMaintenanceSnapshot,
  settlePublicProjectionTestState,
} from "../../../scripts/lib/public-projection-test-state";
import { createIntegrationDb } from "./integration-db";
import { labelRuleCounts } from "../../routes/admin/-artist-rule-reads";
import { bestAlbumCoverUrl } from "../media";
import { DUE_WORK_SOURCE_REPAIR_KIND } from "./due-work";
import { fanOutDueWorkSourceRepairs } from "./due-work-source-repair";
import {
  confirmLabelAlias,
  coverFromJson,
  ensureLabel,
  getConfirmedAliasNames,
  getLabelBySlug,
  isDistributorLabel,
  labelSlug,
  LabelMergeConflictError,
  LabelMergeSameRowError,
  LabelNotFoundError,
  letterPages,
  listKnownLabelNames,
  listLabelAliasCandidates,
  listLabelReviewRows,
  listLabels,
  listLabelsPage,
  mergeLabel,
  reconcileLabels,
  rejectLabelAlias,
  resolveLabelAliasRedirect,
  updateLabelSeedState,
} from "./labels";

let db: Client;

async function seedFinding(trackId: string, label: null | string): Promise<void> {
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

async function labelScopeState(slug: string): Promise<
  | {
      ruledAt: string | null;
      scopeChangedAt: string | null;
      seedState: string;
      updatedAt: string;
    }
  | undefined
> {
  const result = await db.execute({
    args: [slug],
    sql: `select ruled_at, scope_changed_at, seed_state, updated_at
          from labels where slug = ?`,
  });
  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  return {
    ruledAt: row.ruled_at as string | null,
    scopeChangedAt: row.scope_changed_at as string | null,
    seedState: row.seed_state as string,
    updatedAt: row.updated_at as string,
  };
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
    const first = await ensureLabel("Med School", "mbid-medschool");
    const second = await ensureLabel("Medschool", "mbid-medschool");

    expect(second).toBe(first);

    expect(await labelSlugs()).toEqual(["med-school"]);
  });

  it("resolves by MBID first — reusing the row whatever spelling the caller passes", async () => {
    const id = await ensureLabel("Med School", "mbid-medschool");

    const again = await ensureLabel("MedSchool Recordings UK", "mbid-medschool");

    expect(again).toBe(id);
    expect(await listLabels()).toHaveLength(1);
  });

  it("ADOPTS the MBID onto a pre-existing slug row that has none (fill-empty-only)", async () => {
    const minted = await ensureLabel("Shogun Audio");
    expect(await mbLabelIdOf("shogun-audio")).toBeNull();

    const folded = await ensureLabel("Shogun Audio", "mbid-shogun");

    expect(folded).toBe(minted);
    expect(await mbLabelIdOf("shogun-audio")).toBe("mbid-shogun");
    expect(await listLabels()).toHaveLength(1);
  });

  it("never rewrites an MBID already on the row (a different MBID for the same slug is ignored)", async () => {
    await ensureLabel("Critical Music", "mbid-critical");

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

    await linkTracksToLabels(db);

    const page = await listLabelsPage("undecided", 1);

    expect(page.items.map((label) => label.slug).sort()).toEqual(["hospital-records", "pilot"]);

    expect(page.items.find((label) => label.slug === "pilot")?.findingCount).toBe(2);
    expect(page.items.find((label) => label.slug === "hospital-records")?.findingCount).toBe(1);
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
    expect(
      (
        await db.execute(`select source_type, source_id from crawl_projection_repairs
          order by source_type, source_id`)
      ).rows,
    ).toEqual([{ source_id: label.slug, source_type: "label" }]);
    expect(
      (
        await db.execute(`select projection, subject_type, subject_id from projection_repairs
          where subject_type = 'label'`)
      ).rows,
    ).toEqual([
      {
        projection: "artist_qualification",
        subject_id: label.id,
        subject_type: "label",
      },
    ]);
  });

  it("stamps the label-scope watermark when the operator enables a label", async () => {
    await ensureLabel("Gutterfunk");
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    const enabled = await updateLabelSeedState(label.id, "enabled");

    expect(enabled.scopeChangedAt).not.toBeNull();
    expect((await labelScopeState(label.slug))?.scopeChangedAt).toBe(enabled.scopeChangedAt);
  });

  it("preserves the label-scope watermark on a non-enable ruling", async () => {
    await ensureLabel("Critical Music");
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    const disabled = await updateLabelSeedState(label.id, "disabled");
    expect(disabled.scopeChangedAt).toBeNull();

    const watermark = "2026-08-01T00:00:00.000Z";
    await db.execute({
      args: [watermark, label.id],
      sql: `update labels set scope_changed_at = ? where id = ?`,
    });

    const undecided = await updateLabelSeedState(label.id, "undecided");
    expect(undecided.scopeChangedAt).toBe(watermark);
    expect((await labelScopeState(label.slug))?.scopeChangedAt).toBe(watermark);
  });

  it("a bare re-walk stamps scope without changing the ruling or re-staling catalogue rank", async () => {
    await seedFinding("t_rewalk", "1985 Music");
    await reconcileLabels();
    await linkTracksToLabels(db);
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    await updateLabelSeedState(label.id, "disabled");
    await db.execute({
      args: ["2000-01-01T00:00:00.000Z", label.id],
      sql: `update labels set updated_at = ? where id = ?`,
    });
    await db.execute({
      args: [label.id],
      sql: `update tracks set catalogue_rank_corpus = 'still-fresh' where label_id = ?`,
    });
    const before = await labelScopeState(label.slug);
    const beforeProjection = await db.execute(
      `select source_epoch from artist_qualification_state where scope = 'artists'`,
    );
    const beforeRepairs = await db.execute(`select count(*) as n from projection_repairs`);

    const rewalked = await updateLabelSeedState(label.id, undefined, true);
    const after = await labelScopeState(label.slug);
    const ranked = await db.execute({
      args: [label.id],
      sql: `select catalogue_rank_corpus from tracks where label_id = ?`,
    });

    expect(rewalked.scopeChangedAt).not.toBeNull();
    expect(after?.scopeChangedAt).toBe(rewalked.scopeChangedAt);
    expect(after?.seedState).toBe(before?.seedState);
    expect(after?.ruledAt).toBe(before?.ruledAt);
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
    expect(ranked.rows[0]?.catalogue_rank_corpus).toBe("still-fresh");
    expect(
      (
        await db.execute(
          `select source_epoch from artist_qualification_state where scope = 'artists'`,
        )
      ).rows,
    ).toEqual(beforeProjection.rows);
    expect((await db.execute(`select count(*) as n from projection_repairs`)).rows).toEqual(
      beforeRepairs.rows,
    );
  });

  it("404s on an id that is not there", async () => {
    await expect(updateLabelSeedState("lbl_nope", "enabled")).rejects.toBeInstanceOf(
      LabelNotFoundError,
    );
  });

  it("touches nothing already stored — the finding on a disabled label is untouched", async () => {
    await seedFinding("t1", "Anjunabeats");
    await reconcileLabels();

    await linkTracksToLabels(db);
    const [label] = await listLabels();
    expect(label).toBeDefined();
    if (!label) {
      return;
    }

    const before = await db.execute(`select * from tracks order by track_id`);

    await updateLabelSeedState(label.id, "disabled");

    const after = await db.execute(`select * from tracks order by track_id`);

    expect(after.rows).toEqual(before.rows);

    expect((await listLabelsPage("disabled", 1)).items[0]?.findingCount).toBe(1);
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
      args: ["labels/hospital-records.jpg", "2026-07-29T00:00:00.000Z", "hospital-records"],
      sql: `update labels
            set image_key = ?, image_updated_at = ?, image_state = 'resolved'
            where slug = ?`,
    });

    const bySlug = new Map((await listLabels()).map((label) => [label.slug, label]));

    expect(bySlug.get("hospital-records")?.logoImageUrl).toBe(
      `https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/https://found.fluncle.com/labels/hospital-records.jpg?v=${Date.parse("2026-07-29T00:00:00.000Z")}`,
    );
    expect(bySlug.get("anjunabeats")?.logoImageUrl).toBeUndefined();
  });
});

describe("listLabelsPage sections (the waiting queue vs the settled partials)", () => {
  async function seedArtistRule(
    labelId: null | string,
    artistMbid: string,
    verdict: "allow" | "block" = "allow",
  ): Promise<void> {
    const now = "2026-07-01T00:00:00.000Z";

    await db.execute({
      args: [`rule_${artistMbid}_${labelId ?? "global"}`, labelId, artistMbid, verdict, now, now],
      sql: `insert into artist_rules
              (id, label_id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
            values (?, ?, ?, 'Some Act', ?, 'triage', ?, ?)`,
    });
  }

  async function labelIdBySlug(slug: string): Promise<string> {
    const label = (await listLabels()).find((row) => row.slug === slug);

    if (!label) {
      throw new Error(`no label for slug ${slug}`);
    }

    return label.id;
  }

  it("keeps a rule-carrying undecided label out of the waiting set and states its rule count", async () => {
    await ensureLabel("Alpha Records");
    await ensureLabel("Beta Records");
    const beta = await labelIdBySlug("beta-records");
    await seedArtistRule(beta, "mbid-beta-1");
    await seedArtistRule(beta, "mbid-beta-2");

    const waiting = await listLabelsPage("undecided", 1);
    const settled = await listLabelsPage("partial", 1);

    expect(waiting.items.map((label) => label.slug)).toEqual(["alpha-records"]);
    expect(settled.items.map((label) => label.slug)).toEqual(["beta-records"]);

    expect(await labelRuleCounts([beta])).toEqual({ [beta]: { allow: 2, block: 0 } });
  });

  it("leaves a label with only a GLOBAL rule on some artist in the waiting set", async () => {
    await ensureLabel("Alpha Records");
    await seedArtistRule(null, "mbid-global");

    expect((await listLabelsPage("undecided", 1)).items.map((label) => label.slug)).toEqual([
      "alpha-records",
    ]);
    expect((await listLabelsPage("partial", 1)).items).toEqual([]);
  });

  it("does not move a rule-carrying enabled or disabled label out of its own section", async () => {
    await ensureLabel("Alpha Records");
    await ensureLabel("Beta Records");
    const alpha = await labelIdBySlug("alpha-records");
    const beta = await labelIdBySlug("beta-records");
    await updateLabelSeedState(alpha, "enabled");
    await updateLabelSeedState(beta, "disabled");
    await seedArtistRule(alpha, "mbid-alpha", "block");
    await seedArtistRule(beta, "mbid-beta");

    expect((await listLabelsPage("enabled", 1)).items.map((label) => label.slug)).toEqual([
      "alpha-records",
    ]);
    expect((await listLabelsPage("disabled", 1)).items.map((label) => label.slug)).toEqual([
      "beta-records",
    ]);
    expect((await listLabelsPage("undecided", 1)).items).toEqual([]);
    expect((await listLabelsPage("partial", 1)).items).toEqual([]);
  });

  it("still rides the (seed_state, name) index, with the rule probe on artist_rules_label_id_idx", async () => {
    await ensureLabel("Alpha Records");

    const execute = vi.spyOn(db, "execute");
    await listLabelsPage("partial", 1);
    const statement = execute.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (call): call is { args: unknown[]; sql: string } =>
          typeof call === "object" &&
          call !== null &&
          "sql" in call &&
          typeof call.sql === "string" &&
          call.sql.includes("count(*) over ()"),
      );
    execute.mockRestore();

    expect(statement).toBeDefined();

    if (!statement) {
      return;
    }

    const plan = await db.execute({
      args: statement.args as never,
      sql: `explain query plan ${statement.sql}`,
    });
    const details = plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : ""));

    expect(details).toContainEqual(
      expect.stringMatching(
        /SEARCH labels USING INDEX labels_seed_state_name_idx \(seed_state=\?\)/,
      ),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /SEARCH artist_rules USING (COVERING )?INDEX artist_rules_label_id_idx \(label_id=\?\)/,
      ),
    );
    expect(details.filter((detail) => detail.startsWith("SCAN labels"))).toEqual([]);
  });

  it("counts only the unruled labels as waiting, and the two totals sum to the undecided pile", async () => {
    await ensureLabel("Alpha Records");
    await ensureLabel("Beta Records");
    await ensureLabel("Gamma Records");
    await seedArtistRule(await labelIdBySlug("gamma-records"), "mbid-gamma");

    const waiting = await listLabelsPage("undecided", 1);
    const settled = await listLabelsPage("partial", 1);

    expect(waiting.total).toBe(2);
    expect(settled.total).toBe(1);
    expect((await listLabels("undecided")).length).toBe(waiting.total + settled.total);
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
  it("advances only the changed label source and keeps an empty track selection ready", async () => {
    await initializePublicProjectionTestState(db);
    const now = "2026-01-01T00:00:00.000Z";
    await db.batch(
      [
        {
          args: ["lab-enabled", "Hospital Records", "hospital-records", now, now],
          sql: `insert into labels (id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?)`,
        },
        {
          args: ["lab-held", "UKF", "ukf", now, now],
          sql: `insert into labels (id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?)`,
        },
      ],
      "write",
    );

    await backfillLabels(db);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual({
      aggregate: { projectionEpoch: 0, ready: true, sourceEpoch: 0 },
      artists: { projectionEpoch: 0, ready: false, sourceEpoch: 1 },
      repairs: [
        {
          projection: "artist_qualification",
          sourceEpoch: 1,
          subjectId: "lab-enabled",
          subjectType: "label",
        },
      ],
    });
    await settlePublicProjectionTestState(db);
    const ready = await readPublicProjectionMaintenanceSnapshot(db);

    const second = await backfillLabels(db);

    expect(second.bootstrapped).toBe(false);
    expect(await readPublicProjectionMaintenanceSnapshot(db)).toEqual(ready);
  });

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

    await updateLabelSeedState(label.id, "enabled");

    await backfillLabels(db);

    expect(await seedStateOf("anjunabeats")).toBe("enabled");
  });

  it("writes the label_id graph pointer and NOTHING else on a track", async () => {
    await seedFinding("t1", "Anjunabeats");
    const before = await db.execute(`select * from tracks order by track_id`);

    await backfillLabels(db);

    const after = await db.execute(`select * from tracks order by track_id`);

    const strip = (rows: typeof before.rows) =>
      rows.map((row) => {
        const { label_id: _labelId, ...rest } = row as Record<string, unknown>;

        return rest;
      });

    expect(strip(after.rows)).toEqual(strip(before.rows));
    expect(before.rows[0]?.label_id).toBeNull();
    expect(after.rows[0]?.label_id).toEqual(expect.stringMatching(/^lbl_/));
  });
});

async function insertLabel(id: string, name: string, slug: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [id, name, slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

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
    expect(isDistributorLabel("the orchard")).toBe(true);
    expect(isDistributorLabel("Horus Music")).toBe(true);
    expect(isDistributorLabel("Medschool")).toBe(false);
    expect(isDistributorLabel("Hospital Records")).toBe(false);
    expect(isDistributorLabel(null)).toBe(false);
  });
});

describe("the re-mint trap (a confirmed alias's raw string must not re-mint its slug)", () => {
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

    expect(await labelSlugs()).toContain("med-school-recordings");
  });

  it("reconcileLabels never re-mints a confirmed alias's slug", async () => {
    await seedFoldedAwaySpelling();

    const minted = await reconcileLabels();

    expect(minted).toBe(0);

    expect(await labelSlugs()).toEqual(["medschool"]);
  });

  it("ensureLabel resolves a confirmed alias's raw string to the canonical label, minting nothing", async () => {
    await seedFoldedAwaySpelling();

    const id = await ensureLabel("Med School Recordings");

    expect(id).toBe("lbl_med");
    expect(await labelSlugs()).toEqual(["medschool"]);
  });

  it("the deploy backfill (backfillLabels) never re-mints, and links the raw string to the canonical label", async () => {
    await seedFoldedAwaySpelling();

    await backfillLabels(db);

    expect(await labelSlugs()).toEqual(["medschool"]);

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
    expect(await confirmLabelAlias("lba_1")).toBe(false);
    expect(await getConfirmedAliasNames("lbl_med")).toEqual(["Med School Recordings"]);

    expect(await rejectLabelAlias("lba_2")).toBe(true);
    expect(await rejectLabelAlias("lba_2")).toBe(false);

    expect(await listLabelAliasCandidates()).toHaveLength(0);
  });
});

describe("letterPages (the A–Z lane's page math)", () => {
  it("maps each letter to the page its first entity lands on, at the given page size", () => {
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

describe("coverFromJson (the borrowed-cover column shaper)", () => {
  it("returns undefined for a non-string, an empty string, or malformed JSON", () => {
    expect(coverFromJson(null)).toBeUndefined();
    expect(coverFromJson(undefined)).toBeUndefined();
    expect(coverFromJson(42)).toBeUndefined();
    expect(coverFromJson("")).toBeUndefined();
    expect(coverFromJson("{not json")).toBeUndefined();
  });

  it("maps its abbreviated keys to the cover resolver (k→key, s→state, v→updatedAt, u→spotify)", () => {
    const raw = JSON.stringify({ k: "albums/hospital.jpg", s: "resolved", u: null, v: "42" });

    expect(coverFromJson(raw)).toBe(
      bestAlbumCoverUrl({
        imageKey: "albums/hospital.jpg",
        imageState: "resolved",
        imageUpdatedAt: "42",
        spotifyUrl: null,
      }),
    );
  });

  it("falls back to the Spotify url when the master is unresolved", () => {
    const raw = JSON.stringify({ s: null, u: "https://i.scdn.co/image/abc" });

    expect(coverFromJson(raw)).toBe(
      bestAlbumCoverUrl({
        imageKey: null,
        imageState: null,
        imageUpdatedAt: null,
        spotifyUrl: "https://i.scdn.co/image/abc",
      }),
    );
  });

  it("returns undefined when the JSON carries no usable cover fields", () => {
    expect(coverFromJson(JSON.stringify({}))).toBeUndefined();
  });
});

describe("getLabelBySlug lineage edges (RFC label-lineage-remixer U1)", () => {
  async function seedLabelRow(opts: {
    foundedLocation?: string;
    foundingDate?: string;
    name: string;
    parentSlug?: string;
    slug: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await db.execute({
      args: [
        `lbl_${opts.slug}`,
        opts.name,
        opts.slug,
        opts.foundingDate ?? null,
        opts.foundedLocation ?? null,
        opts.parentSlug ? `lbl_${opts.parentSlug}` : null,
        now,
        now,
      ],
      sql: `insert into labels
              (id, name, slug, founding_date, founded_location, parent_label_id, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)`,
    });
  }

  it("returns the founding facts, the parent edge, and the sublabels", async () => {
    await seedLabelRow({
      foundedLocation: "London",
      foundingDate: "1996-04-29",
      name: "Hospital Records",
      slug: "hospital-records",
    });
    await seedLabelRow({
      foundedLocation: "United Kingdom",
      foundingDate: "2006",
      name: "Med School",
      parentSlug: "hospital-records",
      slug: "med-school",
    });

    const child = await getLabelBySlug("med-school");
    expect(child?.foundingDate).toBe("2006");
    expect(child?.foundedLocation).toBe("United Kingdom");
    expect(child?.parentLabel).toEqual({ name: "Hospital Records", slug: "hospital-records" });
    expect(child?.subLabels).toEqual([]);

    const parent = await getLabelBySlug("hospital-records");
    expect(parent?.parentLabel).toBeUndefined();
    expect(parent?.subLabels).toEqual([{ name: "Med School", slug: "med-school" }]);
  });

  it("carries no lineage when the label has none", async () => {
    await seedLabelRow({ name: "Bare Label", slug: "bare-label" });

    const label = await getLabelBySlug("bare-label");
    expect(label?.foundingDate).toBeUndefined();
    expect(label?.foundedLocation).toBeUndefined();
    expect(label?.parentLabel).toBeUndefined();
    expect(label?.subLabels).toEqual([]);
  });
});

async function insertFullLabel(opts: {
  discogsLabelId?: number;
  foundedLocation?: string;
  foundingDate?: string;
  id: string;
  imageKey?: string;
  imageState?: string;
  lineageState?: string;
  mbLabelId?: string;
  name: string;
  parentLabelId?: string;
  ruledAt?: string;
  scopeChangedAt?: string;
  seedState?: string;
  slug: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [
      opts.id,
      opts.name,
      opts.slug,
      opts.seedState ?? "undecided",
      opts.ruledAt ?? null,
      opts.scopeChangedAt ?? null,
      opts.mbLabelId ?? null,
      opts.discogsLabelId ?? null,
      opts.imageKey ?? null,
      opts.imageState ?? "pending",
      opts.foundingDate ?? null,
      opts.foundedLocation ?? null,
      opts.parentLabelId ?? null,
      opts.lineageState ?? "pending",
      now,
      now,
    ],
    sql: `insert into labels
            (id, name, slug, seed_state, ruled_at, scope_changed_at, mb_label_id, discogs_label_id, image_key,
             image_state, founding_date, founded_location, parent_label_id, lineage_state,
             created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });
}

async function insertTrackWithLabelId(trackId: string, labelId: string): Promise<void> {
  await db.execute({
    args: [trackId, "Tune", '["Artist"]', labelId],
    sql: `insert into tracks
            (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, label_id)
          values (?, ?, ?, 'uri', 'url', 0, ?)`,
  });
}

async function labelIdOfTrack(trackId: string): Promise<null | string> {
  const result = await db.execute({
    args: [trackId],
    sql: `select label_id from tracks where track_id = ?`,
  });

  return (result.rows[0]?.label_id as null | string) ?? null;
}

async function insertArtistRule(opts: {
  artistMbid: string;
  id: string;
  labelId?: null | string;
  verdict?: "allow" | "block";
}): Promise<void> {
  const now = "2026-08-02T00:00:00.000Z";
  await db.execute({
    args: [
      opts.id,
      opts.artistMbid,
      `Artist ${opts.artistMbid}`,
      opts.verdict ?? "block",
      opts.labelId ?? null,
      now,
      now,
    ],
    sql: `insert into artist_rules
            (id, artist_mbid, artist_name, verdict, label_id, source, created_at, updated_at)
          values (?, ?, ?, ?, ?, 'operator', ?, ?)`,
  });
}

async function artistRuleIds(): Promise<string[]> {
  const result = await db.execute(`select id from artist_rules order by id`);
  const ids: string[] = [];

  for (const row of result.rows) {
    if (typeof row.id === "string") {
      ids.push(row.id);
    }
  }

  return ids;
}

async function scopeChangedAtOf(labelId: string): Promise<null | string> {
  const result = await db.execute({
    args: [labelId],
    sql: `select scope_changed_at from labels where id = ?`,
  });

  return (result.rows[0]?.scope_changed_at as null | string) ?? null;
}

describe("mergeLabel (the operator's slug-split cleanup)", () => {
  it("removes the deleted label's slug projection before convergence loses its identity", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Canon", slug: "canon" });
    await insertFullLabel({ id: "lbl_loser", name: "Loser", slug: "loser" });
    await db.execute({
      args: [],
      sql: `insert into due_work
        (work_kind, subject_type, subject_id, state, sort_key, next_due_at, source_version,
         generation, updated_at)
        values ('label.image', 'label', 'loser', 'ready', '', '', 'old', 'live',
          '2026-08-26T12:00:00.000Z')`,
    });

    await mergeLabel("loser", "canon");
    expect(
      (
        await db.execute({
          args: ["label.image", "loser"],
          sql: `select state from due_work where work_kind = ? and subject_id = ?`,
        })
      ).rows,
    ).toEqual([]);

    await fanOutDueWorkSourceRepairs(db, { limit: 2, subjectType: "label" });
    expect(
      (
        await db.execute({
          args: ["loser", "lbl_loser", DUE_WORK_SOURCE_REPAIR_KIND],
          sql: `select work_kind from due_work
            where subject_id in (?, ?) and work_kind = ?`,
        })
      ).rows,
    ).toEqual([]);
  });

  it("re-points every FK, reconciles canonical-wins, writes the alias, deletes the loser", async () => {
    await insertFullLabel({
      id: "lbl_canon",
      mbLabelId: "mb-correct",
      name: "Med School",
      seedState: "enabled",
      slug: "med-school",
    });

    await insertFullLabel({
      foundingDate: "1996",
      id: "lbl_loser",
      mbLabelId: "mb-wrong",
      name: "Medschool",
      slug: "medschool",
    });

    await insertFullLabel({
      id: "lbl_child",
      name: "Sub Imprint",
      parentLabelId: "lbl_loser",
      slug: "sub-imprint",
    });

    await insertTrackWithLabelId("t_find", "lbl_loser");
    await insertTrackWithLabelId("t_cat", "lbl_loser");

    await insertAlias({
      alias: "Med-School",
      aliasSlug: "med-school-alt",
      id: "lba_loser",
      labelId: "lbl_loser",
      status: "confirmed",
    });
    await insertArtistRule({
      artistMbid: "artist-loser",
      id: "rule-loser",
      labelId: "lbl_loser",
    });

    const result = await mergeLabel("medschool", "med-school");

    expect(await labelIdOfTrack("t_find")).toBe("lbl_canon");
    expect(await labelIdOfTrack("t_cat")).toBe("lbl_canon");
    expect(result.repointed.tracks).toBe(2);
    expect((await getLabelBySlug("sub-imprint"))?.parentLabel).toEqual({
      name: "Med School",
      slug: "med-school",
    });
    expect(result.repointed.childLabels).toBe(1);
    expect(result.repointed.aliases).toBe(1);

    const canon = await getLabelBySlug("med-school");
    expect(canon?.mbLabelId).toBe("mb-correct");
    expect(canon?.foundingDate).toBe("1996");
    expect(result.reconciled).toContain("foundingDate");
    expect(result.reconciled).not.toContain("mbLabelId");

    expect(await getConfirmedAliasNames("lbl_canon")).toContain("Medschool");
    expect(result.aliasWritten).toEqual({ alias: "Medschool", aliasSlug: "medschool" });

    expect(await labelSlugs()).toEqual(["med-school", "sub-imprint"]);
    expect(await getConfirmedAliasNames("lbl_canon")).toContain("Med-School");
    expect(result.droppedRules).toBe(1);
    expect(
      (
        await db.execute(`select source_type, source_id from crawl_projection_repairs
          order by source_type, source_id`)
      ).rows,
    ).toEqual([
      { source_id: "artist-loser", source_type: "artist" },
      { source_id: "med-school", source_type: "label" },
      { source_id: "medschool", source_type: "label" },
    ]);
  });

  it("resolves seed_state by ruled_at precedence — the more recent ruling wins", async () => {
    await insertFullLabel({
      id: "lbl_canon",
      name: "Canon",
      seedState: "undecided",
      slug: "canon",
    });
    await insertFullLabel({
      id: "lbl_loser",
      name: "Loser",
      ruledAt: "2026-07-10T00:00:00.000Z",
      seedState: "disabled",
      slug: "loser",
    });

    const result = await mergeLabel("loser", "canon");

    expect(result.seedState).toBe("disabled");
    expect((await getLabelBySlug("canon"))?.id).toBe("lbl_canon");
    expect(await seedStateOf("canon")).toBe("disabled");
  });

  it("drops only the loser's scoped rules and reports the deliberate loss", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Canon", slug: "canon" });
    await insertFullLabel({ id: "lbl_loser", name: "Loser", slug: "loser" });
    await insertArtistRule({ artistMbid: "mbid-canon", id: "arl_canon", labelId: "lbl_canon" });
    await insertArtistRule({ artistMbid: "mbid-loser-1", id: "arl_loser_1", labelId: "lbl_loser" });
    await insertArtistRule({ artistMbid: "mbid-loser-2", id: "arl_loser_2", labelId: "lbl_loser" });
    await insertArtistRule({ artistMbid: "mbid-global", id: "arl_global" });

    const result = await mergeLabel("loser", "canon");

    expect(result.droppedRules).toBe(2);
    expect(await artistRuleIds()).toEqual(["arl_canon", "arl_global"]);
  });

  it("keeps the latest scope watermark so a merge never moves the re-arm cursor backwards", async () => {
    const older = "2026-07-31T00:00:00.000Z";
    const newer = "2026-08-01T00:00:00.000Z";
    await insertFullLabel({
      id: "lbl_canon",
      name: "Canon",
      scopeChangedAt: older,
      slug: "canon",
    });
    await insertFullLabel({
      id: "lbl_loser",
      name: "Loser",
      scopeChangedAt: newer,
      slug: "loser",
    });

    await mergeLabel("loser", "canon");

    expect(await scopeChangedAtOf("lbl_canon")).toBe(newer);
  });

  it("REFUSES when both rows carry an operator ruling and their seed states disagree", async () => {
    await insertFullLabel({
      id: "lbl_canon",
      name: "Canon",
      ruledAt: "2026-07-11T00:00:00.000Z",
      seedState: "enabled",
      slug: "canon",
    });
    await insertFullLabel({
      id: "lbl_loser",
      name: "Loser",
      ruledAt: "2026-07-10T00:00:00.000Z",
      seedState: "disabled",
      slug: "loser",
    });

    await expect(mergeLabel("loser", "canon")).rejects.toBeInstanceOf(LabelMergeConflictError);

    expect(await labelSlugs()).toEqual(["canon", "loser"]);
  });

  it("closes the re-mint trap: the losing name resolves to the canonical after merge", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Med School", slug: "med-school" });
    await insertFullLabel({ id: "lbl_loser", name: "Medschool", slug: "medschool" });

    await mergeLabel("medschool", "med-school");

    expect(await ensureLabel("Medschool")).toBe("lbl_canon");
    expect(await labelSlugs()).toEqual(["med-school"]);

    await seedFinding("t_remint", "Medschool");
    expect(await reconcileLabels()).toBe(0);
    expect(await labelIdOfTrack("t_remint")).toBe(null);
    expect(await labelSlugs()).toEqual(["med-school"]);
  });

  it("the merged-away slug resolves for the 301 redirect", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Med School", slug: "med-school" });
    await insertFullLabel({ id: "lbl_loser", name: "Medschool", slug: "medschool" });

    await mergeLabel("medschool", "med-school");

    expect(await resolveLabelAliasRedirect("medschool")).toBe("med-school");

    expect(await resolveLabelAliasRedirect("never-existed")).toBeUndefined();
  });

  it("refuses a self-merge and a merge of an unknown slug", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Med School", slug: "med-school" });

    await expect(mergeLabel("med-school", "med-school")).rejects.toBeInstanceOf(
      LabelMergeSameRowError,
    );
    await expect(mergeLabel("ghost", "med-school")).rejects.toBeInstanceOf(LabelNotFoundError);
    await expect(mergeLabel("med-school", "ghost")).rejects.toBeInstanceOf(LabelNotFoundError);
  });

  it("binds exactly its placeholders across the whole merge batch", async () => {
    await insertFullLabel({ id: "lbl_canon", name: "Med School", slug: "med-school" });
    await insertFullLabel({
      foundingDate: "1996",
      id: "lbl_loser",
      name: "Medschool",
      slug: "medschool",
    });
    await insertFullLabel({
      id: "lbl_child",
      name: "Sub",
      parentLabelId: "lbl_loser",
      slug: "sub",
    });
    await insertTrackWithLabelId("t1", "lbl_loser");

    const batchCalls: Array<{ argc: number; sql: string }> = [];
    const originalBatch = db.batch.bind(db);
    db.batch = ((stmts: unknown, mode?: unknown) => {
      if (Array.isArray(stmts)) {
        for (const stmt of stmts as Array<{ args?: unknown[]; sql: string }>) {
          batchCalls.push({
            argc: Array.isArray(stmt.args) ? stmt.args.length : 0,
            sql: stmt.sql,
          });
        }
      }

      return originalBatch(
        stmts as Parameters<Client["batch"]>[0],
        mode as Parameters<Client["batch"]>[1],
      );
    }) as Client["batch"];

    await mergeLabel("medschool", "med-school");

    expect(batchCalls.length).toBeGreaterThan(0);
    for (const call of batchCalls) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;
      expect({ argc: call.argc, placeholders, sql: call.sql.slice(0, 40) }).toMatchObject({
        argc: placeholders,
        placeholders,
      });
    }
  });
});

describe("listKnownLabelNames (the /tracks label filter typeahead pool)", () => {
  async function pointTrackAtLabel(trackId: string, labelId: string): Promise<void> {
    await db.execute({
      args: [labelId, trackId],
      sql: `update tracks set label_id = ? where track_id = ?`,
    });
  }

  it("drops a blank-named label so the combobox never offers an empty option", async () => {
    await insertLabel("lbl_real", "Hospital Records", "hospital-records");
    await insertLabel("lbl_blank", "", "blank-label");
    await insertLabel("lbl_space", "   ", "space-label");
    await seedFinding("t-real", "Hospital Records");
    await seedFinding("t-blank", "");
    await seedFinding("t-space", "   ");
    await pointTrackAtLabel("t-real", "lbl_real");
    await pointTrackAtLabel("t-blank", "lbl_blank");
    await pointTrackAtLabel("t-space", "lbl_space");

    const names = await listKnownLabelNames();

    expect(names).toContain("Hospital Records");
    expect(names).not.toContain("");
    expect(names).not.toContain("   ");
    expect(names.every((name) => name.trim() !== "")).toBe(true);
  });

  it("drives the join from the certified findings, never from a walk of the label's tracks", async () => {
    await insertLabel("lbl_big", "Big Imprint", "big-imprint");
    await insertLabel("lbl_other", "Other Imprint", "other-imprint");
    await seedFinding("t-big-found", "Big Imprint");
    await pointTrackAtLabel("t-big-found", "lbl_big");

    for (let index = 0; index < 40; index += 1) {
      await db.execute({
        args: [`t-cat-${index}`, index % 2 === 0 ? "lbl_big" : "lbl_other"],
        sql: `insert into tracks
                (track_id, title, artists_json, duration_ms, label_id, album_image_url, release_date)
              values (?, 'Tune', '["Artist"]', 0, ?, 'https://covers.example/x.jpg', '2024-01-01')`,
      });
    }

    const execute = vi.spyOn(db, "execute");
    const names = await listKnownLabelNames();

    const sqlOf = (statement: unknown): string => {
      if (typeof statement === "string") {
        return statement;
      }

      return typeof statement === "object" &&
        statement !== null &&
        "sql" in statement &&
        typeof statement.sql === "string"
        ? statement.sql
        : "";
    };
    const sql = execute.mock.calls
      .map((call) => sqlOf(call[0] as unknown))
      .find((text) => text.includes("from findings"));
    execute.mockRestore();

    expect(names).toEqual(["Big Imprint"]);
    expect(sql).toBeDefined();

    if (sql === undefined) {
      return;
    }

    const plan = await db.execute(`explain query plan ${sql}`);
    const details = plan.rows.map((row) => (typeof row.detail === "string" ? row.detail : ""));

    expect(details[0]).toBe("SCAN findings");
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH tracks USING INDEX sqlite_autoindex_tracks_1 \(track_id=\?\)$/,
      ),
    );
    expect(details.filter((detail) => detail.startsWith("SCAN tracks"))).toEqual([]);
  });
});
