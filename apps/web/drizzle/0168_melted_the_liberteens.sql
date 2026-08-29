CREATE TABLE `database_admission_contenders` (
	`acquired_at_ms` integer,
	`contender_id` text PRIMARY KEY NOT NULL,
	`enqueued_at_ms` integer NOT NULL,
	`fencing_token` integer,
	`lane` text NOT NULL,
	`lease_expires_at_ms` integer,
	`operation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`queue_heartbeat_at_ms` integer NOT NULL,
	`run_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "database_admission_contenders_lane_check" CHECK("database_admission_contenders"."lane" in ('heavy-read', 'write')),
	CONSTRAINT "database_admission_contenders_state_check" CHECK("database_admission_contenders"."state" in ('active', 'queued')),
	CONSTRAINT "database_admission_contenders_identity_bounds_check" CHECK(typeof("database_admission_contenders"."contender_id") = 'text' and length(cast("database_admission_contenders"."contender_id" as blob)) between 1 and 192
        and typeof("database_admission_contenders"."operation_id") = 'text' and length(cast("database_admission_contenders"."operation_id" as blob)) between 1 and 64
        and typeof("database_admission_contenders"."owner_id") = 'text' and length(cast("database_admission_contenders"."owner_id" as blob)) between 1 and 128
        and typeof("database_admission_contenders"."run_id") = 'text' and length(cast("database_admission_contenders"."run_id" as blob)) between 1 and 128),
	CONSTRAINT "database_admission_contenders_time_check" CHECK("database_admission_contenders"."enqueued_at_ms" >= 0 and "database_admission_contenders"."queue_heartbeat_at_ms" >= "database_admission_contenders"."enqueued_at_ms"
        and "database_admission_contenders"."updated_at_ms" >= "database_admission_contenders"."enqueued_at_ms"
        and ("database_admission_contenders"."acquired_at_ms" is null or "database_admission_contenders"."acquired_at_ms" >= "database_admission_contenders"."enqueued_at_ms")
        and ("database_admission_contenders"."lease_expires_at_ms" is null or "database_admission_contenders"."lease_expires_at_ms" >= "database_admission_contenders"."enqueued_at_ms")),
	CONSTRAINT "database_admission_contenders_lifecycle_check" CHECK(("database_admission_contenders"."state" = 'queued' and "database_admission_contenders"."acquired_at_ms" is null and "database_admission_contenders"."fencing_token" is null and "database_admission_contenders"."lease_expires_at_ms" is null)
        or ("database_admission_contenders"."state" = 'active' and "database_admission_contenders"."acquired_at_ms" is not null and "database_admission_contenders"."fencing_token" is not null and "database_admission_contenders"."fencing_token" > 0 and "database_admission_contenders"."lease_expires_at_ms" is not null and "database_admission_contenders"."lease_expires_at_ms" > "database_admission_contenders"."acquired_at_ms"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_admission_contenders_owner_run_idx` ON `database_admission_contenders` (`owner_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `database_admission_contenders_active_lane_idx` ON `database_admission_contenders` (`lane`) WHERE "database_admission_contenders"."state" = 'active';--> statement-breakpoint
CREATE INDEX `database_admission_contenders_queue_idx` ON `database_admission_contenders` (`lane`,`state`,`enqueued_at_ms`,`contender_id`) WHERE "database_admission_contenders"."state" = 'queued';--> statement-breakpoint
CREATE INDEX `database_admission_contenders_queue_heartbeat_idx` ON `database_admission_contenders` (`state`,`queue_heartbeat_at_ms`,`contender_id`) WHERE "database_admission_contenders"."state" = 'queued';--> statement-breakpoint
CREATE INDEX `database_admission_contenders_lease_idx` ON `database_admission_contenders` (`state`,`lease_expires_at_ms`,`lane`,`contender_id`) WHERE "database_admission_contenders"."state" = 'active';--> statement-breakpoint
CREATE TABLE `database_admission_lanes` (
	`lane` text PRIMARY KEY NOT NULL,
	`next_fencing_token` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "database_admission_lanes_lane_check" CHECK("database_admission_lanes"."lane" in ('heavy-read', 'write')),
	CONSTRAINT "database_admission_lanes_token_check" CHECK("database_admission_lanes"."next_fencing_token" >= 0 and "database_admission_lanes"."updated_at_ms" >= 0)
);
