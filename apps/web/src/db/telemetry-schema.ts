import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
