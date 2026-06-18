CREATE TABLE `account` (
	`access_token` text,
	`access_token_expires_at` integer,
	`account_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`id_token` text,
	`password` text,
	`provider_id` text NOT NULL,
	`refresh_token` text,
	`refresh_token_expires_at` integer,
	`scope` text,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limit_events` (
	`action` text NOT NULL,
	`bucket` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`ip_hash` text,
	`user_agent_hash` text,
	`user_id` text
);
--> statement-breakpoint
CREATE INDEX `rate_limit_action_bucket_created_at_idx` ON `rate_limit_events` (`action`,`bucket`,`created_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_user_action_created_at_idx` ON `rate_limit_events` (`user_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_ip_action_created_at_idx` ON `rate_limit_events` (`ip_hash`,`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`ip_address` text,
	`token` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`display_username` text,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`image` text,
	`last_seen_at` integer,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`username` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `user_data_exports` (
	`completed_at` text,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text,
	`requested_at` text NOT NULL,
	`status` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_data_exports_user_requested_idx` ON `user_data_exports` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `user_deletion_requests` (
	`completed_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`requested_at` text NOT NULL,
	`status` text NOT NULL,
	`summary_json` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_deletion_requests_user_requested_idx` ON `user_deletion_requests` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `user_galaxy_collections` (
	`first_collected_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_collected_at` text NOT NULL,
	`log_id` text NOT NULL,
	`source_surface` text NOT NULL,
	`track_id` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_galaxy_collections_user_track_idx` ON `user_galaxy_collections` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_user_first_idx` ON `user_galaxy_collections` (`user_id`,`first_collected_at`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_track_first_idx` ON `user_galaxy_collections` (`track_id`,`first_collected_at`);--> statement-breakpoint
CREATE TABLE `user_galaxy_state` (
	`created_at` text NOT NULL,
	`deaths` integer DEFAULT 0 NOT NULL,
	`last_played_at` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_saved_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text NOT NULL,
	`note` text,
	`saved_at` text NOT NULL,
	`track_id` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_saved_findings_user_track_idx` ON `user_saved_findings` (`user_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
ALTER TABLE `submissions` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `submissions_user_id_created_at_idx` ON `submissions` (`user_id`,`created_at`);