CREATE TABLE `turso_usage_alerts` (
	`cycle` text NOT NULL,
	`delivered_at` text,
	`level_cents` integer NOT NULL,
	`projected_overage_usd` real NOT NULL,
	`raised_at` text NOT NULL,
	PRIMARY KEY(`cycle`, `level_cents`)
);
--> statement-breakpoint
CREATE TABLE `turso_usage_snapshots` (
	`bytes_synced` integer NOT NULL,
	`created_at` text NOT NULL,
	`cycle` text NOT NULL,
	`detail_json` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL,
	`overage_usd` real NOT NULL,
	`plan` text NOT NULL,
	`price_table_version` text NOT NULL,
	`projected_overage_usd` real NOT NULL,
	`rows_read` integer NOT NULL,
	`rows_written` integer NOT NULL,
	`storage_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turso_usage_snapshots_observed_at_idx` ON `turso_usage_snapshots` (`observed_at`);--> statement-breakpoint
CREATE INDEX `turso_usage_snapshots_cycle_observed_at_idx` ON `turso_usage_snapshots` (`cycle`,`observed_at`);