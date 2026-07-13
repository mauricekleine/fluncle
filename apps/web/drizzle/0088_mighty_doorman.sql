CREATE TABLE `platform_stats` (
	`captured_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`metric` text NOT NULL,
	`platform` text NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_stats_platform_metric_captured_at_idx` ON `platform_stats` (`platform`,`metric`,`captured_at`);