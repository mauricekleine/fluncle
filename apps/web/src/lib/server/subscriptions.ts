import { randomUUID } from "node:crypto";
import { type SubscriptionDTO } from "@fluncle/contracts";
import { getDb, typedRow, typedRows } from "./db";
import { ApiError } from "./spotify";

// The operator's private cost ledger (COST-02) — the server-side CRUD over the
// `subscriptions` table. The oRPC `admin-subscriptions` handlers wrap these, and the
// `/admin/costs` station reads them in-process. There is no public or agent caller:
// the ledger is the operator's single source of truth for Fluncle's spend, so every
// write is operator tier. Vendor names + amounts are private data — they live here in
// the DB at runtime, never in a committed file.

const NAME_MAX = 200;
const VENDOR_MAX = 200;
const CURRENCY_MAX = 8;
const URL_MAX = 2048;
const POWERS_MAX = 500;
const NOTES_MAX = 2000;

// The closed sets — mirrored from the drizzle `subscriptions` typed-enum columns.
const CATEGORIES = ["infra", "AI", "media", "distribution", "domains", "tooling"] as const;
const CADENCES = ["monthly", "annual", "one-off", "usage"] as const;
const STATUSES = ["active", "cancelled", "trial"] as const;

type Category = (typeof CATEGORIES)[number];
type Cadence = (typeof CADENCES)[number];
type Status = (typeof STATUSES)[number];

type SubscriptionRow = {
  amount: number;
  billing_url: string | null;
  cadence: Cadence;
  category: Category;
  created_at: string;
  currency: string;
  id: string;
  name: string;
  notes: string | null;
  powers: string | null;
  renews_at: string | null;
  status: Status;
  updated_at: string;
  vendor: string;
};

const SUBSCRIPTION_SELECT = `select
  id, name, vendor, category, cadence, amount, currency, status,
  renews_at, billing_url, powers, notes, created_at, updated_at
  from subscriptions`;

/** Map a DB row to the wire DTO — nulls become undefined (the DTO's optional fields). */
function rowToSubscription(row: SubscriptionRow): SubscriptionDTO {
  return {
    amount: row.amount,
    billingUrl: row.billing_url ?? undefined,
    cadence: row.cadence,
    category: row.category,
    createdAt: row.created_at,
    currency: row.currency,
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
    powers: row.powers ?? undefined,
    renewsAt: row.renews_at ?? undefined,
    status: row.status,
    updatedAt: row.updated_at,
    vendor: row.vendor,
  };
}

// ── The operator's input (LOOSE — validated here) ─────────────────────────────

export type SubscriptionInput = {
  amount?: unknown;
  billingUrl?: unknown;
  cadence?: unknown;
  category?: unknown;
  currency?: unknown;
  name?: unknown;
  notes?: unknown;
  powers?: unknown;
  renewsAt?: unknown;
  status?: unknown;
  vendor?: unknown;
};

/** The full ledger, most-recently-updated first (then created, then id — stable). */
export async function listSubscriptions(): Promise<SubscriptionDTO[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `${SUBSCRIPTION_SELECT}
          order by updated_at desc, created_at desc, id desc`,
  });

  return typedRows<SubscriptionRow>(result.rows).map(rowToSubscription);
}

/** Add one cost line. Requires name, vendor, category, cadence, and a numeric amount. */
export async function createSubscription(input: SubscriptionInput): Promise<SubscriptionDTO> {
  const name = requiredText(input.name, "name", NAME_MAX);
  const vendor = requiredText(input.vendor, "vendor", VENDOR_MAX);
  const category = requireEnum(input.category, CATEGORIES, "category");
  const cadence = requireEnum(input.cadence, CADENCES, "cadence");
  const amount = requireAmount(input.amount);
  const currency = optionalCurrency(input.currency) ?? "EUR";
  const status =
    input.status === undefined ? "active" : requireEnum(input.status, STATUSES, "status");
  const renewsAt = optionalIsoDate(input.renewsAt, "renewsAt");
  const billingUrl = optionalText(input.billingUrl, URL_MAX);
  const powers = optionalText(input.powers, POWERS_MAX);
  const notes = optionalText(input.notes, NOTES_MAX);

  const now = new Date().toISOString();
  const id = randomUUID();
  const db = await getDb();

  await db.execute({
    args: [
      id,
      name,
      vendor,
      category,
      cadence,
      amount,
      currency,
      status,
      renewsAt ?? null,
      billingUrl ?? null,
      powers ?? null,
      notes ?? null,
      now,
      now,
    ],
    sql: `insert into subscriptions (
        id, name, vendor, category, cadence, amount, currency, status,
        renews_at, billing_url, powers, notes, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  });

  return getSubscriptionById(id);
}

/** Edit a cost line's fields. Only the provided fields change. */
export async function updateSubscription(
  id: string,
  input: SubscriptionInput,
): Promise<SubscriptionDTO> {
  // Confirm it exists first — a missing row is a 404, not a silent no-op.
  await getSubscriptionById(id);

  const sets: string[] = [];
  const args: Array<string | number | null> = [];

  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };

  if (input.name !== undefined) {
    push("name", requiredText(input.name, "name", NAME_MAX));
  }

  if (input.vendor !== undefined) {
    push("vendor", requiredText(input.vendor, "vendor", VENDOR_MAX));
  }

  if (input.category !== undefined) {
    push("category", requireEnum(input.category, CATEGORIES, "category"));
  }

  if (input.cadence !== undefined) {
    push("cadence", requireEnum(input.cadence, CADENCES, "cadence"));
  }

  if (input.amount !== undefined) {
    push("amount", requireAmount(input.amount));
  }

  if (input.currency !== undefined) {
    const currency = optionalCurrency(input.currency);
    push("currency", currency ?? "EUR");
  }

  if (input.status !== undefined) {
    push("status", requireEnum(input.status, STATUSES, "status"));
  }

  if (input.renewsAt !== undefined) {
    push("renews_at", optionalIsoDate(input.renewsAt, "renewsAt") ?? null);
  }

  if (input.billingUrl !== undefined) {
    push("billing_url", optionalText(input.billingUrl, URL_MAX) ?? null);
  }

  if (input.powers !== undefined) {
    push("powers", optionalText(input.powers, POWERS_MAX) ?? null);
  }

  if (input.notes !== undefined) {
    push("notes", optionalText(input.notes, NOTES_MAX) ?? null);
  }

  if (sets.length === 0) {
    throw new ApiError("no_fields", "No updatable fields provided", 400);
  }

  sets.push("updated_at = ?");
  args.push(new Date().toISOString(), id);

  const db = await getDb();
  await db.execute({ args, sql: `update subscriptions set ${sets.join(", ")} where id = ?` });

  return getSubscriptionById(id);
}

/** Remove a cost line by id. */
export async function deleteSubscription(id: string): Promise<{ id: string }> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `delete from subscriptions where id = ? returning id`,
  });

  const row = typedRow<{ id: string }>(result.rows);

  if (!row) {
    throw new ApiError("subscription_not_found", "Subscription not found", 404);
  }

  return { id: row.id };
}

/** A single cost line by id, or a 404. */
export async function getSubscriptionById(id: string): Promise<SubscriptionDTO> {
  const db = await getDb();
  const result = await db.execute({
    args: [id],
    sql: `${SUBSCRIPTION_SELECT} where id = ? limit 1`,
  });
  const row = typedRow<SubscriptionRow>(result.rows);

  if (!row) {
    throw new ApiError("subscription_not_found", "Subscription not found", 404);
  }

  return rowToSubscription(row);
}

// ── Validation ────────────────────────────────────────────────────────────────

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_input", `${field} is required`, 400);
  }

  return value.trim().slice(0, maxLength);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new ApiError("invalid_input", `${field} must be one of: ${allowed.join(", ")}`, 400);
}

// Amount in minor units (cents). Accept a number or a numeric string; reject
// non-integers and negatives — a charge is a whole-cent, non-negative figure.
function requireAmount(value: unknown): number {
  const amount = typeof value === "string" ? Number(value) : value;

  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new ApiError("invalid_input", "amount must be a non-negative integer (minor units)", 400);
  }

  return amount;
}

function optionalCurrency(value: unknown): string | undefined {
  const text = optionalText(value, CURRENCY_MAX);

  return text ? text.toUpperCase() : undefined;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new ApiError("invalid_input", "Expected text input", 400);
  }

  return value.trim() ? value.trim().slice(0, maxLength) : null;
}

function optionalIsoDate(value: unknown, field: string): string | null | undefined {
  const text = optionalText(value, 80);

  if (text === undefined || text === null) {
    return text;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError("invalid_date", `${field} must be a valid date`, 400);
  }

  return date.toISOString();
}
