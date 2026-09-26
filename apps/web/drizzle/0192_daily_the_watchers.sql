CREATE TABLE `follow_digest_deliveries` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`last_error` text,
	`payload_json` text NOT NULL,
	`release_count` integer NOT NULL,
	`resend_id` text,
	`sent_at` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`week_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_digest_deliveries_user_week_idx` ON `follow_digest_deliveries` (`user_id`,`week_key`);--> statement-breakpoint
ALTER TABLE `user_follow_digests` ADD `manage_token_version` integer DEFAULT 0 NOT NULL;