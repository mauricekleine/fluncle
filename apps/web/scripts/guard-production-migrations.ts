/** Validate the generated journal and plan every migration not yet stamped in production. */
import { type Client } from "@libsql/client/web";

export type MigrationJournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type GuardDependencies = {
  journalJson: string;
  readLastAppliedWhen: () => Promise<null | number>;
};

export type ProductionMigrationPlan = {
  lastAppliedWhen: null | number;
  pendingEntries: MigrationJournalEntry[];
  throughTag: null | string;
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

/** Mirror Drizzle's ledger rule: every journal timestamp above the applied maximum is pending. */
export function planProductionMigrations(
  entries: readonly MigrationJournalEntry[],
  lastAppliedWhen: null | number,
): ProductionMigrationPlan {
  if (lastAppliedWhen !== null && !Number.isSafeInteger(lastAppliedWhen)) {
    throw new Error("production migration guard: migration ledger timestamp is invalid");
  }

  const pendingEntries = entries.filter(
    (entry) => lastAppliedWhen === null || entry.when > lastAppliedWhen,
  );

  return {
    lastAppliedWhen,
    pendingEntries,
    throughTag: pendingEntries.at(-1)?.tag ?? null,
  };
}

/** Read the ledger and plan the complete pending journal for one atomic Cloudflare deployment. */
export async function planPendingProductionMigrations(
  dependencies: GuardDependencies,
): Promise<ProductionMigrationPlan> {
  const entries = parseMigrationJournal(dependencies.journalJson);
  const lastAppliedWhen = await dependencies.readLastAppliedWhen();

  return planProductionMigrations(entries, lastAppliedWhen);
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
