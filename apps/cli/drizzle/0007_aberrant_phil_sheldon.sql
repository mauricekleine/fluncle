CREATE TABLE `social_posts` (
	`created_at` text NOT NULL,
	`external_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`published_at` text,
	`scheduled_for` text,
	`status` text NOT NULL,
	`track_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_posts_track_platform_idx` ON `social_posts` (`track_id`,`platform`);