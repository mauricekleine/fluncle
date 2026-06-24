CREATE TABLE `service_check_samples` (
	`at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`latency_ms` integer,
	`service` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `service_check_samples_service_at_idx` ON `service_check_samples` (`service`,`at`);