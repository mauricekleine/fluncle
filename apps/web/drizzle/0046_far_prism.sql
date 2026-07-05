CREATE TABLE `mixtape_clip_social_posts` (
	`caption` text,
	`clip_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`posted_url` text,
	`postiz_id` text,
	`scheduled_for` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_clip_social_posts_clip_platform_idx` ON `mixtape_clip_social_posts` (`clip_id`,`platform`);--> statement-breakpoint
CREATE INDEX `mixtape_clip_social_posts_status_idx` ON `mixtape_clip_social_posts` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
