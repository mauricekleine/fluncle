CREATE TABLE `run_events` (
	`checked` integer,
	`created_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`errors` integer,
	`exit_code` integer NOT NULL,
	`expected_interval_ms` integer,
	`gate_state` text,
	`id` text PRIMARY KEY NOT NULL,
	`missing_fields` text NOT NULL,
	`occurred_at` text NOT NULL,
	`ok` integer NOT NULL,
	`produced` integer,
	`queue_depth` integer,
	`run_duration_ms` integer,
	`summary_raw` text,
	`summary_status` text NOT NULL,
	`unit` text NOT NULL,
	`unrecognised_fields` text NOT NULL,
	`vendor_calls` integer
);
--> statement-breakpoint
CREATE INDEX `run_events_unit_occurred_at_idx` ON `run_events` (`unit`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `run_events_occurred_at_idx` ON `run_events` (`occurred_at`);