import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const runEvents = sqliteTable(
  "run_events",
  {
    accessClass: text("access_class", { enum: ["heavy-read", "read", "write"] }),

    attemptCount: integer("attempt_count"),

    batchCount: integer("batch_count"),

    checked: integer("checked"),

    createdAt: text("created_at").notNull(),

    endedAt: text("ended_at").notNull(),

    errors: integer("errors"),

    exitCode: integer("exit_code").notNull(),

    expectedIntervalMs: integer("expected_interval_ms"),

    gateState: text("gate_state", {
      enum: ["active", "disabled", "dry-run", "forced", "locked", "paused"],
    }),

    id: text("id").primaryKey(),

    missingFields: text("missing_fields").notNull(),

    occurredAt: text("occurred_at").notNull(),

    ok: integer("ok").notNull(),

    operationId: text("operation_id"),

    outcome: text("outcome", { enum: ["failure", "success"] }),

    produced: integer("produced"),

    queueDepth: integer("queue_depth"),

    release: text("release").notNull().default("unknown"),

    runDurationMs: integer("run_duration_ms"),

    selfAssertedOk: integer("self_asserted_ok"),

    summaryRaw: text("summary_raw"),

    summaryStatus: text("summary_status", {
      enum: ["absent", "malformed", "not_object", "parsed"],
    }).notNull(),

    unit: text("unit").notNull(),

    unrecognisedFields: text("unrecognised_fields").notNull(),

    vendorCalls: integer("vendor_calls"),
  },
  (table) => [
    index("run_events_unit_occurred_at_idx").on(table.unit, table.occurredAt),
    index("run_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export const tursoUsageSnapshots = sqliteTable(
  "turso_usage_snapshots",
  {
    bytesSynced: integer("bytes_synced").notNull(),

    createdAt: text("created_at").notNull(),

    cycle: text("cycle").notNull(),

    detailJson: text("detail_json").notNull(),

    id: text("id").primaryKey(),

    observedAt: text("observed_at").notNull(),

    overageUsd: real("overage_usd").notNull(),

    plan: text("plan").notNull(),

    priceTableVersion: text("price_table_version").notNull(),

    projectedOverageUsd: real("projected_overage_usd").notNull(),

    rowsRead: integer("rows_read").notNull(),

    rowsWritten: integer("rows_written").notNull(),

    storageBytes: integer("storage_bytes").notNull(),
  },
  (table) => [
    index("turso_usage_snapshots_observed_at_idx").on(table.observedAt),
    index("turso_usage_snapshots_cycle_observed_at_idx").on(table.cycle, table.observedAt),
  ],
);

export const tursoUsageAlerts = sqliteTable(
  "turso_usage_alerts",
  {
    cycle: text("cycle").notNull(),

    deliveredAt: text("delivered_at"),

    levelCents: integer("level_cents").notNull(),

    projectedOverageUsd: real("projected_overage_usd").notNull(),

    raisedAt: text("raised_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.cycle, table.levelCents] })],
);

export const telemetryAdmissionLanes = sqliteTable(
  "database_admission_lanes",
  {
    lane: text("lane", { enum: ["heavy-read", "write"] }).primaryKey(),
    nextFencingToken: integer("next_fencing_token").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check("database_admission_lanes_lane_check", sql`${table.lane} in ('heavy-read', 'write')`),
    check(
      "database_admission_lanes_token_check",
      sql`${table.nextFencingToken} >= 0 and ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const telemetryAdmissionContenders = sqliteTable(
  "database_admission_contenders",
  {
    acquiredAtMs: integer("acquired_at_ms"),
    contenderId: text("contender_id").primaryKey(),
    enqueuedAtMs: integer("enqueued_at_ms").notNull(),
    fencingToken: integer("fencing_token"),
    lane: text("lane", { enum: ["heavy-read", "write"] }).notNull(),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    operationId: text("operation_id").notNull(),
    ownerId: text("owner_id").notNull(),
    queueHeartbeatAtMs: integer("queue_heartbeat_at_ms").notNull(),
    runId: text("run_id").notNull(),
    state: text("state", { enum: ["active", "queued"] }).notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "database_admission_contenders_lane_check",
      sql`${table.lane} in ('heavy-read', 'write')`,
    ),
    check("database_admission_contenders_state_check", sql`${table.state} in ('active', 'queued')`),
    check(
      "database_admission_contenders_identity_bounds_check",
      sql`typeof(${table.contenderId}) = 'text' and length(cast(${table.contenderId} as blob)) between 1 and 192
        and typeof(${table.operationId}) = 'text' and length(cast(${table.operationId} as blob)) between 1 and 64
        and typeof(${table.ownerId}) = 'text' and length(cast(${table.ownerId} as blob)) between 1 and 128
        and typeof(${table.runId}) = 'text' and length(cast(${table.runId} as blob)) between 1 and 128`,
    ),
    check(
      "database_admission_contenders_time_check",
      sql`${table.enqueuedAtMs} >= 0 and ${table.queueHeartbeatAtMs} >= ${table.enqueuedAtMs}
        and ${table.updatedAtMs} >= ${table.enqueuedAtMs}
        and (${table.acquiredAtMs} is null or ${table.acquiredAtMs} >= ${table.enqueuedAtMs})
        and (${table.leaseExpiresAtMs} is null or ${table.leaseExpiresAtMs} >= ${table.enqueuedAtMs})`,
    ),
    check(
      "database_admission_contenders_lifecycle_check",
      sql`(${table.state} = 'queued' and ${table.acquiredAtMs} is null and ${table.fencingToken} is null and ${table.leaseExpiresAtMs} is null)
        or (${table.state} = 'active' and ${table.acquiredAtMs} is not null and ${table.fencingToken} is not null and ${table.fencingToken} > 0 and ${table.leaseExpiresAtMs} is not null and ${table.leaseExpiresAtMs} > ${table.acquiredAtMs})`,
    ),
    uniqueIndex("database_admission_contenders_owner_run_idx").on(table.ownerId, table.runId),
    uniqueIndex("database_admission_contenders_active_lane_idx")
      .on(table.lane)
      .where(sql`${table.state} = 'active'`),
    index("database_admission_contenders_queue_idx")
      .on(table.lane, table.state, table.enqueuedAtMs, table.contenderId)
      .where(sql`${table.state} = 'queued'`),
    index("database_admission_contenders_queue_heartbeat_idx")
      .on(table.state, table.queueHeartbeatAtMs, table.contenderId)
      .where(sql`${table.state} = 'queued'`),
    index("database_admission_contenders_lease_idx")
      .on(table.state, table.leaseExpiresAtMs, table.lane, table.contenderId)
      .where(sql`${table.state} = 'active'`),
  ],
);

export const databaseAdmissionControl = sqliteTable(
  "database_admission_control",
  {
    epoch: integer("epoch").notNull(),
    id: integer("id").primaryKey(),
    storeOpen: integer("store_open").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "database_admission_control_singleton_check",
      sql`${table.id} = 1 and ${table.epoch} >= 0 and ${table.storeOpen} in (0, 1) and ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const databaseWriteProbes = sqliteTable(
  "database_write_probes",
  {
    id: text("id").primaryKey(),
    latencyMs: integer("latency_ms"),
    observedAtMs: integer("observed_at_ms").notNull(),
    outcome: text("outcome", { enum: ["failed", "ok", "slow", "stalled"] }).notNull(),
  },
  (table) => [
    check(
      "database_write_probes_outcome_check",
      sql`${table.outcome} in ('failed', 'ok', 'slow', 'stalled')`,
    ),
    index("database_write_probes_observed_at_idx").on(table.observedAtMs, table.id),
  ],
);
