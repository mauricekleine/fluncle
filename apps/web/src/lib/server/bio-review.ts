import { getDb, typedRows } from "./db";
import { type EntityKind } from "./bio";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "./due-work";

export type BioReviewRow = {
  anchorAt: string;
  kind: EntityKind;

  name: string;
  slug: string;

  violations: string[];
};

export type BioReviewResolution = "keep" | "rewrite";

export const BIO_REVIEW_QUEUE_LIMIT = 25;

function tableFor(kind: EntityKind): "artists" | "labels" | "albums" {
  return kind === "artist" ? "artists" : kind === "label" ? "labels" : "albums";
}

export function parseBioViolations(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function bioBypassColumns(
  violations: readonly string[] | null | undefined,
  nowIso: string,
): [string | null, string | null] {
  return violations && violations.length > 0
    ? [nowIso, JSON.stringify([...violations])]
    : [null, null];
}

type BioReviewSqlRow = {
  bypassed_at: string;
  kind: EntityKind;
  name: string;
  slug: string;
  violations: string | null;
};

function reviewArm(kind: EntityKind): string {
  return `select * from (
            select '${kind}' as kind, slug, name,
                   bio_gate_bypassed_at as bypassed_at, bio_voice_violations as violations
            from ${tableFor(kind)}
            where bio_gate_bypassed_at is not null
            order by bio_gate_bypassed_at asc
            limit ?
          )`;
}

export async function listBioReviewRows(): Promise<BioReviewRow[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
      BIO_REVIEW_QUEUE_LIMIT,
    ],
    sql: `${reviewArm("artist")}
          union all
          ${reviewArm("label")}
          union all
          ${reviewArm("album")}
          order by bypassed_at asc, kind asc, slug asc
          limit ?`,
  });

  return typedRows<BioReviewSqlRow>(result.rows).map((row) => ({
    anchorAt: row.bypassed_at,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    violations: parseBioViolations(row.violations),
  }));
}

export async function resolveBioReview(input: {
  kind: EntityKind;
  resolution: BioReviewResolution;
  slug: string;
}): Promise<boolean> {
  const db = await getDb();
  const clear = `bio_gate_bypassed_at = null, bio_voice_violations = null`;
  const wipe =
    input.resolution === "rewrite"
      ? `bio = null, bio_prompt_version = null, bio_status = 'pending', `
      : "";
  const table = tableFor(input.kind);
  const results = await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        input.kind,
        {
          args: [input.slug],
          sql: `select id as subject_id from ${table}
                where slug = ? and bio_gate_bypassed_at is not null`,
        },
        { producer: "bio-review-resolution" },
      ),
      {
        args: [new Date().toISOString(), input.slug],

        sql: `update ${table}
                set ${wipe}${clear}, updated_at = ?
              where slug = ?
                and bio_gate_bypassed_at is not null`,
      },
    ],
    "write",
  );

  return (results.at(-1)?.rowsAffected ?? 0) > 0;
}
