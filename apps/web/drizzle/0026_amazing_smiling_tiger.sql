CREATE TABLE `push_receipts` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_receipts_created_at_idx` ON `push_receipts` (`created_at`);--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`app_version` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`muted_json` text,
	`platform` text NOT NULL,
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE INDEX `push_tokens_user_id_idx` ON `push_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_tokens_last_seen_at_idx` ON `push_tokens` (`last_seen_at`);