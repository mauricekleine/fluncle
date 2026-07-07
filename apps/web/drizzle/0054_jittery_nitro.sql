CREATE TABLE `cost_events` (
	`cost_basis` text NOT NULL,
	`created_at` text NOT NULL,
	`estimated_usd` real,
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text,
	`model` text,
	`occurred_at` text NOT NULL,
	`quantity` real NOT NULL,
	`source` text NOT NULL,
	`step` text NOT NULL,
	`track_id` text,
	`unit_type` text NOT NULL,
	`vendor` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cost_events_step_occurred_at_idx` ON `cost_events` (`step`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_track_id_occurred_at_idx` ON `cost_events` (`track_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_occurred_at_idx` ON `cost_events` (`occurred_at`);