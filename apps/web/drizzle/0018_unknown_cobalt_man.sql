CREATE TABLE `mixtape_social_posts` (
	`created_at` text NOT NULL,
	`external_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`mixtape_id` text NOT NULL,
	`platform` text NOT NULL,
	`published_at` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_social_posts_mixtape_platform_idx` ON `mixtape_social_posts` (`mixtape_id`,`platform`);