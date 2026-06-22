CREATE TABLE `editions` (
	`added_at` text,
	`content_json` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`number` integer,
	`send_external_id` text,
	`send_provider` text,
	`sent_at` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`subject` text,
	`updated_at` text NOT NULL,
	`window_since` text,
	`window_until` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editions_number_unique` ON `editions` (`number`);