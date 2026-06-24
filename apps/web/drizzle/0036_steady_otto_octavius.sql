CREATE TABLE `service_status` (
	`checked_at` text NOT NULL,
	`latency_ms` integer,
	`message` text,
	`service` text PRIMARY KEY NOT NULL,
	`since` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_events` (
	`at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message` text,
	`service` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_events_at_idx` ON `status_events` (`at`);