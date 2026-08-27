#!/usr/bin/env bun
/**
 * Fail closed before the production deploy path can remove a compatibility route or apply a
 * protected schema contraction.
 *
 * The checked-out operation-receipt contract determines whether the keyed GET compatibility route
 * remains. Once it is absent, every deploy requires the persistent public caller-floor SHA. Drizzle
 * decides what is pending from the greatest `created_at` value in `__drizzle_migrations`; this guard
 * reads the same ledger coordinate and the generated journal, then requires a one-run approval whose
 * value is exactly the pending protected tags in journal order. The ordinary `db:migrate` command
 * deliberately remains unchanged for local databases.
 */
import { createClient, type Client } from "@libsql/client/web";
import { readFileSync } from "node:fs";

import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";

export const PROTECTED_MIGRATION_APPROVAL_ENV = "FLUNCLE_PROTECTED_MIGRATION_APPROVAL";
export const OPERATION_RECEIPT_CALLER_FLOOR_ENV = "FLUNCLE_OPERATION_RECEIPT_CALLER_FLOOR";
export const OPERATION_RECEIPT_CALLER_FLOOR_SHA = "a58f9441088728efa03f8745813ac17425229c18";
export const PROTECTED_CONTRACTION_TAGS = [
  "0169_lonely_mariko_yashida",
  "0170_motionless_squadron_supreme",
  "0171_watery_skreet",
] as const;

export type MigrationJournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type GuardDependencies = {
  approval: string | undefined;
  journalJson: string;
  readLastAppliedWhen: () => Promise<null | number>;
};

type GuardResult = {
  lastAppliedWhen: null | number;
  pendingTags: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Detect the exact compatibility operation in the checked-out oRPC contract source. */
export function hasLegacyOperationReceiptRoute(contractSource: string): boolean {
  return /^\s*["']?get_operation_receipt_legacy["']?\s*:/m.test(contractSource);
}

/** Require the durable deployed-caller floor only after this checkout removes the legacy route. */
export function requireOperationReceiptCallerFloor(
  contractSource: string,
  callerFloor: string | undefined,
): boolean {
  const legacyRoutePresent = hasLegacyOperationReceiptRoute(contractSource);
  if (legacyRoutePresent) {
    return true;
  }

  if (callerFloor !== OPERATION_RECEIPT_CALLER_FLOOR_SHA) {
    throw new Error(
      `production migration guard: get_operation_receipt_legacy is absent; ${OPERATION_RECEIPT_CALLER_FLOOR_ENV} must exactly equal the deployed caller floor "${OPERATION_RECEIPT_CALLER_FLOOR_SHA}"`,
    );
  }

  return false;
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

  if (
    protectedEntries.length !== PROTECTED_CONTRACTION_TAGS.length ||
    protectedEntries.some((entry, index) => entry.tag !== PROTECTED_CONTRACTION_TAGS[index])
  ) {
    throw new Error(
      "production migration guard: protected contraction tags are missing or out of journal order",
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
 * This makes the operator acknowledge the exact contraction set the target would apply now.
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
        `production migration guard: ${PROTECTED_MIGRATION_APPROVAL_ENV} must be unset when no protected contraction is pending`,
      );
    }

    return;
  }

  if (supplied !== expected) {
    throw new Error(
      `production migration guard: protected contractions are pending; set ${PROTECTED_MIGRATION_APPROVAL_ENV} exactly to "${expected}" for this attended deploy`,
    );
  }
}

/** Purely orchestrate journal parsing, ledger inspection, and the exact approval decision. */
export async function guardProtectedProductionMigrations(
  dependencies: GuardDependencies,
): Promise<GuardResult> {
  const entries = parseMigrationJournal(dependencies.journalJson);
  const lastAppliedWhen = await dependencies.readLastAppliedWhen();
  const pendingTags = pendingProtectedMigrationTags(entries, lastAppliedWhen);

  requireProtectedMigrationApproval(pendingTags, dependencies.approval);

  return { lastAppliedWhen, pendingTags };
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

async function main(): Promise<void> {
  const operationReceiptContractSource = readFileSync(
    new URL("../../../packages/contracts/src/orpc/admin-operation-receipts.ts", import.meta.url),
    "utf8",
  );
  const legacyOperationReceiptRoutePresent = requireOperationReceiptCallerFloor(
    operationReceiptContractSource,
    process.env[OPERATION_RECEIPT_CALLER_FLOOR_ENV],
  );

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error(
      "production migration guard: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required",
    );
  }

  const client = createClient({ authToken, concurrency: REMOTE_DB_CONCURRENCY, url });
  try {
    const journalJson = readFileSync(
      new URL("../drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    );
    const result = await guardProtectedProductionMigrations({
      approval: process.env[PROTECTED_MIGRATION_APPROVAL_ENV],
      journalJson,
      readLastAppliedWhen: () => readLastAppliedMigrationWhen(client),
    });

    if (legacyOperationReceiptRoutePresent) {
      console.warn(
        "PRODUCTION MIGRATION GUARD: clear — get_operation_receipt_legacy remains in this checkout.",
      );
    } else {
      console.warn(
        `PRODUCTION MIGRATION GUARD: caller floor confirmed — ${OPERATION_RECEIPT_CALLER_FLOOR_SHA}.`,
      );
    }

    if (result.pendingTags.length === 0) {
      console.warn("PRODUCTION MIGRATION GUARD: clear — no protected contraction is pending.");
    } else {
      console.warn(
        `PRODUCTION MIGRATION GUARD: approved — ${result.pendingTags.join(",")} may run in this deploy.`,
      );
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "production migration guard failed");
    process.exitCode = 1;
  }
}
