/**
 * Plan and authorize the production migration prefix a command may apply.
 *
 * The ordinary deploy phase stops immediately before the first pending protected contraction. The
 * two attended phases stop at the exact release-manifest boundaries: H4 applies 0169–0170 and H8
 * applies 0171. A caller cannot widen those bounds with an arbitrary tag or environment value.
 */
import { type Client } from "@libsql/client/web";

export const PROTECTED_MIGRATION_APPROVAL_ENV = "FLUNCLE_PROTECTED_MIGRATION_APPROVAL";
export const EXPANSION_CEILING_TAG = "0168_melted_the_liberteens";
export const PROTECTED_CONTRACTION_TAGS = [
  "0169_lonely_mariko_yashida",
  "0170_motionless_squadron_supreme",
  "0171_watery_skreet",
] as const;
export const PRODUCTION_MIGRATION_PHASES = ["deploy", "h4", "h8"] as const;

export type ProductionMigrationPhase = (typeof PRODUCTION_MIGRATION_PHASES)[number];

export type MigrationJournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type GuardDependencies = {
  approval: string | undefined;
  journalJson: string;
  phase: ProductionMigrationPhase;
  readLastAppliedWhen: () => Promise<null | number>;
};

export type ProductionMigrationPlan = {
  blockedProtectedTags: string[];
  lastAppliedWhen: null | number;
  pendingEntries: MigrationJournalEntry[];
  pendingProtectedTags: string[];
  phase: ProductionMigrationPhase;
  throughTag: null | string;
  throughWhen: null | number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the generated Drizzle journal and reject structural drift instead of guessing. */
export function parseMigrationJournal(journalJson: string): MigrationJournalEntry[] {
  let journal: unknown;

  try {
    journal = JSON.parse(journalJson);
  } catch {
    throw new Error("production migration guard: Drizzle journal is not valid JSON");
  }

  if (!isRecord(journal) || journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) {
    throw new Error("production migration guard: Drizzle journal has an unsupported shape");
  }

  const seenTags = new Set<string>();
  let previousWhen = Number.NEGATIVE_INFINITY;

  return journal.entries.map((rawEntry, position) => {
    if (!isRecord(rawEntry)) {
      throw new Error(`production migration guard: journal entry ${position} is invalid`);
    }

    const { idx, tag, when } = rawEntry;
    if (
      idx !== position ||
      typeof tag !== "string" ||
      !/^\d{4}_[a-z0-9_]+$/.test(tag) ||
      !Number.isSafeInteger(when) ||
      Number(when) <= previousWhen
    ) {
      throw new Error(`production migration guard: journal entry ${position} is invalid`);
    }
    if (seenTags.has(tag)) {
      throw new Error(`production migration guard: journal tag ${tag} is duplicated`);
    }

    seenTags.add(tag);
    previousWhen = Number(when);

    return { idx: position, tag, when: Number(when) };
  });
}

function protectedJournalEntries(
  entries: readonly MigrationJournalEntry[],
): MigrationJournalEntry[] {
  const protectedTags = new Set<string>(PROTECTED_CONTRACTION_TAGS);
  const protectedEntries = entries.filter((entry) => protectedTags.has(entry.tag));
  const firstProtected = protectedEntries[0];
  const expansionCeiling = firstProtected ? entries[firstProtected.idx - 1] : undefined;

  if (
    protectedEntries.length !== PROTECTED_CONTRACTION_TAGS.length ||
    protectedEntries.some(
      (entry, index) =>
        entry.tag !== PROTECTED_CONTRACTION_TAGS[index] ||
        (firstProtected !== undefined && entry.idx !== firstProtected.idx + index),
    ) ||
    expansionCeiling?.tag !== EXPANSION_CEILING_TAG
  ) {
    throw new Error(
      `production migration guard: ${EXPANSION_CEILING_TAG} and the protected contraction tags are missing or out of journal order`,
    );
  }

  return protectedEntries;
}

/** Mirror Drizzle's pending rule: every journal timestamp greater than the ledger maximum runs. */
export function pendingProtectedMigrationTags(
  entries: readonly MigrationJournalEntry[],
  lastAppliedWhen: null | number,
): string[] {
  if (lastAppliedWhen !== null && !Number.isSafeInteger(lastAppliedWhen)) {
    throw new Error("production migration guard: migration ledger timestamp is invalid");
  }

  return protectedJournalEntries(entries)
    .filter((entry) => lastAppliedWhen === null || entry.when > lastAppliedWhen)
    .map((entry) => entry.tag);
}

/**
 * Approval is deliberately literal: no sorting, trimming, subsets, supersets, or stale values.
 * This makes the operator acknowledge the exact contraction set this attended phase can apply.
 */
export function requireProtectedMigrationApproval(
  pendingTags: readonly string[],
  approval: string | undefined,
): void {
  const expected = pendingTags.join(",");
  const supplied = approval ?? "";

  if (pendingTags.length === 0) {
    if (supplied !== "") {
      throw new Error(
        `production migration guard: ${PROTECTED_MIGRATION_APPROVAL_ENV} must be unset when this phase has no protected contraction to apply`,
      );
    }

    return;
  }

  if (supplied !== expected) {
    throw new Error(
      `production migration guard: protected contractions are pending in this attended phase; set ${PROTECTED_MIGRATION_APPROVAL_ENV} exactly to "${expected}" for this one run`,
    );
  }
}

function entryByTag(entries: readonly MigrationJournalEntry[], tag: string): MigrationJournalEntry {
  const entry = entries.find((candidate) => candidate.tag === tag);
  if (!entry) {
    throw new Error(`production migration guard: required journal tag ${tag} is absent`);
  }

  return entry;
}

function requireAppliedThrough(
  prerequisite: MigrationJournalEntry,
  lastAppliedWhen: null | number,
  phase: ProductionMigrationPhase,
): void {
  if (lastAppliedWhen === null || lastAppliedWhen < prerequisite.when) {
    throw new Error(
      `production migration guard: phase ${phase} requires the target ledger through ${prerequisite.tag} before it may run`,
    );
  }
}

/** Build the one deterministic journal prefix allowed for this phase. */
export function planProductionMigrations(input: {
  approval: string | undefined;
  entries: readonly MigrationJournalEntry[];
  lastAppliedWhen: null | number;
  phase: ProductionMigrationPhase;
}): ProductionMigrationPlan {
  const { approval, entries, lastAppliedWhen, phase } = input;
  if (lastAppliedWhen !== null && !Number.isSafeInteger(lastAppliedWhen)) {
    throw new Error("production migration guard: migration ledger timestamp is invalid");
  }

  const protectedEntries = protectedJournalEntries(entries);
  const pendingProtected = protectedEntries.filter(
    (entry) => lastAppliedWhen === null || entry.when > lastAppliedWhen,
  );
  let through: MigrationJournalEntry | undefined;

  if (phase === "deploy") {
    const firstPendingProtected = pendingProtected[0];
    through = firstPendingProtected ? entries[firstPendingProtected.idx - 1] : entries.at(-1);
  } else if (phase === "h4") {
    const prerequisite = entryByTag(entries, EXPANSION_CEILING_TAG);
    requireAppliedThrough(prerequisite, lastAppliedWhen, phase);
    through = entryByTag(entries, PROTECTED_CONTRACTION_TAGS[1]);
  } else {
    const prerequisite = entryByTag(entries, PROTECTED_CONTRACTION_TAGS[1]);
    requireAppliedThrough(prerequisite, lastAppliedWhen, phase);
    through = entryByTag(entries, PROTECTED_CONTRACTION_TAGS[2]);
  }

  const pendingEntries = entries.filter(
    (entry) =>
      (lastAppliedWhen === null || entry.when > lastAppliedWhen) &&
      through !== undefined &&
      entry.when <= through.when,
  );
  const protectedTags = new Set<string>(PROTECTED_CONTRACTION_TAGS);
  const pendingProtectedTags = pendingEntries
    .filter((entry) => protectedTags.has(entry.tag))
    .map((entry) => entry.tag);

  if (phase === "deploy" && pendingProtectedTags.length > 0) {
    throw new Error("production migration guard: ordinary deploy planned a protected contraction");
  }

  requireProtectedMigrationApproval(pendingProtectedTags, approval);

  return {
    blockedProtectedTags: pendingProtected
      .filter((entry) => through === undefined || entry.when > through.when)
      .map((entry) => entry.tag),
    lastAppliedWhen,
    pendingEntries,
    pendingProtectedTags,
    phase,
    throughTag: through?.tag ?? null,
    throughWhen: through?.when ?? null,
  };
}

/** Purely orchestrate journal parsing, ledger inspection, and the exact phase decision. */
export async function guardProtectedProductionMigrations(
  dependencies: GuardDependencies,
): Promise<ProductionMigrationPlan> {
  const entries = parseMigrationJournal(dependencies.journalJson);
  const lastAppliedWhen = await dependencies.readLastAppliedWhen();

  return planProductionMigrations({
    approval: dependencies.approval,
    entries,
    lastAppliedWhen,
    phase: dependencies.phase,
  });
}

function migrationTimestamp(value: unknown): number {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : Number.NaN;

  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new Error("production migration guard: migration ledger timestamp is invalid");
  }

  return timestamp;
}

/** Read only the migration metadata Drizzle itself uses; a missing/empty ledger means all are pending. */
export async function readLastAppliedMigrationWhen(
  client: Pick<Client, "execute">,
): Promise<null | number> {
  const table = await client.execute({
    args: [],
    sql: "select 1 as present from sqlite_master where type = 'table' and name = '__drizzle_migrations' limit 1",
  });
  if (table.rows.length === 0) {
    return null;
  }

  const latest = await client.execute({
    args: [],
    sql: "select created_at from __drizzle_migrations order by created_at desc limit 1",
  });
  const row = latest.rows[0];
  if (!row) {
    return null;
  }

  return migrationTimestamp(row.created_at);
}
