CREATE TABLE `rate_limit_counters` (
	`action` text NOT NULL,
	`bucket` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_counter_action_bucket_window_idx` ON `rate_limit_counters` (`action`,`bucket`,`window_start`);