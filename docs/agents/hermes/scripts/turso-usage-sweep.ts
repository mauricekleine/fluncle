#!/usr/bin/env bun

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK ?? "";
const TURSO_PLATFORM_API_URL = process.env.TURSO_PLATFORM_API_URL ?? "https://api.turso.tech";
const TURSO_PLATFORM_API_TOKEN = process.env.TURSO_PLATFORM_API_TOKEN ?? "";
const TURSO_PLATFORM_ORG = process.env.TURSO_PLATFORM_ORG ?? "";

const RECORD_PATH = "/api/v1/admin/costs/turso-usage";
const ACKNOWLEDGE_PATH = "/api/v1/admin/costs/turso-usage/alerts";
const BOARD_URL = "https://www.fluncle.com/admin/costs";

const log = (message: string) => console.error(`[turso-usage-sweep] ${message}`);

export type UsageTotals = {
  bytesSynced: number;
  rowsRead: number;
  rowsWritten: number;
  storageBytes: number;
};

export type DatabaseUsage = UsageTotals & { name: string };

export type OrganizationUsage = {
  databases: (UsageTotals & { uuid: string })[];
  totals: UsageTotals;
};

export type Subscription = { name: string; overages: boolean; timeline: string | null };

export type RecordPayload = {
  databases: DatabaseUsage[];
  observedAt: string;
  plan: Subscription;
  upcomingInvoiceUsd: number | null;
  usage: UsageTotals;
};

export type PendingAlert = {
  cycle: string;
  deliveredAt: string | null;
  levelUsd: number;
  projectedOverageUsd: number;
  raisedAt: string;
};

export type RecordResponse = {
  ok?: boolean;
  pendingAlerts?: PendingAlert[];
  snapshot?: {
    cycle?: string;
    cycleEnd?: string;
    overageUsd?: number;
    projectedOverageUsd?: number;
    rateBasis?: string;
    resources?: { key: string; overageUsd: number; projectedOverageUsd: number }[];
  };
  stored?: boolean;
  thresholdUsd?: number;
};

export type AcknowledgeResponse = { acknowledged?: number; ok?: boolean };

export type TursoUsageSummary = {
  alertAcknowledged: boolean | null;
  checked: null | number;
  cycle: null | string;
  databases: number;
  error: null | string;
  errors: number;
  notified: boolean | null;
  ok: boolean;
  overageUsd: null | number;
  pendingAlerts: number;
  produced: null | number;
  projectedOverageUsd: null | number;
  rateBasis: null | string;
  reason: null | string;
  upcomingInvoiceUsd: null | number;
};

export type SweepDeps = {
  acknowledge: (alerts: { cycle: string; levelUsd: number }[]) => Promise<AcknowledgeResponse>;
  fetchTurso: (path: string) => Promise<unknown>;
  notify: (message: string) => Promise<boolean>;
  now: () => Date;
  record: (payload: RecordPayload) => Promise<RecordResponse>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : 0;
}

function totalsFrom(value: unknown): UsageTotals {
  const usage = asRecord(value);

  return {
    bytesSynced: count(usage.bytes_synced),
    rowsRead: count(usage.rows_read),
    rowsWritten: count(usage.rows_written),
    storageBytes: count(usage.storage_bytes),
  };
}

export function parseOrganizationUsage(body: unknown): OrganizationUsage {
  const organization = asRecord(asRecord(body).organization);

  if (!("usage" in organization)) {
    throw new Error("the Turso usage response carried no organization.usage");
  }

  const databases = Array.isArray(organization.databases) ? organization.databases : [];

  return {
    databases: databases.flatMap((entry) => {
      const database = asRecord(entry);
      const uuid = typeof database.uuid === "string" ? database.uuid : "";

      return uuid ? [{ uuid, ...totalsFrom(database.total) }] : [];
    }),
    totals: totalsFrom(organization.usage),
  };
}

export function parseDatabaseNames(body: unknown): Map<string, string> {
  const databases = asRecord(body).databases;
  const names = new Map<string, string>();

  for (const entry of Array.isArray(databases) ? databases : []) {
    const database = asRecord(entry);

    if (typeof database.DbId === "string" && typeof database.Name === "string") {
      names.set(database.DbId, database.Name);
    }
  }

  return names;
}

export function parseSubscription(body: unknown): Subscription {
  const subscription = asRecord(asRecord(body).subscription);
  const name =
    typeof subscription.plan === "string"
      ? subscription.plan
      : typeof subscription.name === "string"
        ? subscription.name
        : "";

  if (!name) {
    throw new Error("the Turso subscription response carried no plan");
  }

  return {
    name,
    overages: subscription.overages === true,
    timeline: typeof subscription.timeline === "string" ? subscription.timeline : null,
  };
}

export function parseUpcomingInvoiceUsd(body: unknown): number | null {
  const invoices = asRecord(body).invoices;

  if (!Array.isArray(invoices)) {
    return null;
  }

  const amounts = invoices
    .map((entry) => Number(asRecord(entry).amount_due))
    .filter((amount) => Number.isFinite(amount) && amount >= 0);

  return amounts.length === 0 ? null : Math.max(...amounts);
}

export function unnamedDatabase(uuid: string): string {
  return `unlisted ${uuid.slice(0, 8)}`;
}

export function buildPayload(input: {
  names: Map<string, string>;
  observedAt: Date;
  subscription: Subscription;
  upcomingInvoiceUsd: number | null;
  usage: OrganizationUsage;
}): RecordPayload {
  return {
    databases: input.usage.databases.map(({ uuid, ...totals }) => ({
      ...totals,
      name: input.names.get(uuid) ?? unnamedDatabase(uuid),
    })),
    observedAt: input.observedAt.toISOString(),
    plan: input.subscription,
    upcomingInvoiceUsd: input.upcomingInvoiceUsd,
    usage: input.usage.totals,
  };
}

const RESOURCE_LABELS: Record<string, string> = {
  embeddedSyncs: "embedded syncs",
  rowsRead: "rows read",
  rowsWritten: "rows written",
  storage: "storage",
};

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function discordMessage(response: RecordResponse, pending: PendingAlert[]): string {
  const snapshot = response.snapshot ?? {};
  const highest = Math.max(...pending.map((alert) => alert.levelUsd));
  const drivers = (snapshot.resources ?? [])
    .filter((resource) => resource.projectedOverageUsd > 0)
    .sort((a, b) => b.projectedOverageUsd - a.projectedOverageUsd)
    .map(
      (resource) =>
        `${RESOURCE_LABELS[resource.key] ?? resource.key} ${usd(resource.projectedOverageUsd)}`,
    )
    .join(", ");
  const resetDay = snapshot.cycleEnd ? snapshot.cycleEnd.slice(0, 10) : "the reset";

  return [
    `Turso overage is on course for ${usd(snapshot.projectedOverageUsd ?? 0)} by ${resetDay}, past the ${usd(highest)} alert line.`,
    `So far this cycle: ${usd(snapshot.overageUsd ?? 0)}.${drivers ? ` Projected by resource: ${drivers}.` : ""}`,
    `An upper bound at list rates. ${BOARD_URL}`,
  ].join("\n");
}

function emptySummary(): TursoUsageSummary {
  return {
    alertAcknowledged: null,
    checked: null,
    cycle: null,
    databases: 0,
    error: null,
    errors: 0,
    notified: null,
    ok: true,
    overageUsd: null,
    pendingAlerts: 0,
    produced: null,
    projectedOverageUsd: null,
    rateBasis: null,
    reason: null,
    upcomingInvoiceUsd: null,
  };
}

export function missingCredentialsSummary(missing: string[]): TursoUsageSummary {
  return {
    ...emptySummary(),
    error: `missing ${missing.join(", ")}`,
    errors: 1,
    ok: false,
    reason: "missing_credentials",
  };
}

async function readInvoice(deps: SweepDeps): Promise<number | null> {
  try {
    return parseUpcomingInvoiceUsd(await deps.fetchTurso("/invoices?type=upcoming"));
  } catch (error) {
    log(
      `the upcoming invoice read failed; recording without it: ${error instanceof Error ? error.message : String(error)}`,
    );

    return null;
  }
}

export async function runTursoUsageSweep(deps: SweepDeps): Promise<TursoUsageSummary> {
  const summary = emptySummary();
  const observedAt = deps.now();
  const [usageBody, databasesBody, subscriptionBody] = await Promise.all([
    deps.fetchTurso("/usage"),
    deps.fetchTurso("/databases"),
    deps.fetchTurso("/subscription"),
  ]);
  const payload = buildPayload({
    names: parseDatabaseNames(databasesBody),
    observedAt,
    subscription: parseSubscription(subscriptionBody),
    upcomingInvoiceUsd: await readInvoice(deps),
    usage: parseOrganizationUsage(usageBody),
  });

  summary.checked = 1;
  summary.databases = payload.databases.length;
  summary.upcomingInvoiceUsd = payload.upcomingInvoiceUsd;

  const response = await deps.record(payload);

  if (response.ok !== true || !response.snapshot) {
    return {
      ...summary,
      error: "record_turso_usage returned no snapshot",
      errors: 1,
      ok: false,
      produced: 0,
    };
  }

  summary.cycle = response.snapshot.cycle ?? null;
  summary.overageUsd = response.snapshot.overageUsd ?? null;
  summary.projectedOverageUsd = response.snapshot.projectedOverageUsd ?? null;
  summary.rateBasis = response.snapshot.rateBasis ?? null;

  if (response.stored !== true) {
    return {
      ...summary,
      error: "the Worker has no telemetry database; the reading was priced but not stored",
      errors: 1,
      ok: false,
      produced: 0,
      reason: "telemetry_unprovisioned",
    };
  }

  summary.produced = 1;

  const pending = Array.isArray(response.pendingAlerts) ? response.pendingAlerts : [];

  summary.pendingAlerts = pending.length;

  if (pending.length === 0) {
    return summary;
  }

  summary.notified = await deps.notify(discordMessage(response, pending));

  if (!summary.notified) {
    return {
      ...summary,
      alertAcknowledged: false,
      error: `${pending.length} overage alert(s) pending and the Discord post did not land; the next run re-sends`,
      errors: 1,
      ok: false,
      reason: "alert_undelivered",
    };
  }

  try {
    const acknowledged = await deps.acknowledge(
      pending.map((alert) => ({ cycle: alert.cycle, levelUsd: alert.levelUsd })),
    );

    summary.alertAcknowledged = acknowledged.ok === true;
  } catch (error) {
    summary.alertAcknowledged = false;
    log(
      `alert acknowledgement failed; the next run re-sends it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!summary.alertAcknowledged) {
    return {
      ...summary,
      error: "the Discord alert landed but its acknowledgement did not; the next run re-sends it",
      errors: 1,
      ok: false,
      reason: "alert_unacknowledged",
    };
  }

  return summary;
}

async function fetchTurso(path: string): Promise<unknown> {
  const url = `${TURSO_PLATFORM_API_URL}/v1/organizations/${encodeURIComponent(TURSO_PLATFORM_ORG)}${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TURSO_PLATFORM_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `Turso platform ${path} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  return response.json();
}

async function sendJson<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    method,
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }

  return (await response.json()) as T;
}

async function notifyDiscord(content: string): Promise<boolean> {
  if (!DISCORD_ALERT_WEBHOOK) {
    log("no DISCORD_ALERT_WEBHOOK; the alert stays pending for the next run");

    return false;
  }

  try {
    const response = await fetch(DISCORD_ALERT_WEBHOOK, {
      body: JSON.stringify({ content }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log(`discord post returned ${response.status}; the alert stays pending for the next run`);
    }

    return response.ok;
  } catch (error) {
    log(
      `discord post failed; the alert stays pending for the next run: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

export function missingCredentials(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value === "")
    .map(([name]) => name)
    .sort();
}

async function main(): Promise<TursoUsageSummary> {
  const missing = missingCredentials({
    FLUNCLE_API_TOKEN: API_TOKEN,
    TURSO_PLATFORM_API_TOKEN,
    TURSO_PLATFORM_ORG,
  });

  if (missing.length > 0) {
    return missingCredentialsSummary(missing);
  }

  return runTursoUsageSweep({
    acknowledge: (alerts) => sendJson<AcknowledgeResponse>("PUT", ACKNOWLEDGE_PATH, { alerts }),
    fetchTurso,
    notify: notifyDiscord,
    now: () => new Date(),
    record: (payload) => sendJson<RecordResponse>("POST", RECORD_PATH, payload),
  });
}

if (import.meta.main) {
  const started = Date.now();

  try {
    const summary = await main();

    console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

    if (!summary.ok) {
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    log(`turso-usage-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        ...emptySummary(),
        error: message,
        errors: 1,
        ok: false,
        reason: "turso_usage_failed",
      }),
    );
    process.exit(1);
  }
}
