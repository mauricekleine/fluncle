CREATE TABLE `social_metrics` (
	`average_view_percentage` real,
	`captured_at` text NOT NULL,
	`captured_day` text NOT NULL,
	`comments` integer,
	`created_at` text NOT NULL,
	`external_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`impressions` integer,
	`likes` integer,
	`platform` text NOT NULL,
	`saves` integer,
	`shares` integer,
	`source` text DEFAULT 'postiz' NOT NULL,
	`track_id` text NOT NULL,
	`views` integer,
	`watch_time_seconds` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_metrics_external_source_day_idx` ON `social_metrics` (`external_id`,`source`,`captured_day`);--> statement-breakpoint
CREATE INDEX `social_metrics_track_captured_at_idx` ON `social_metrics` (`track_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `findings` ADD `video_plate_subject` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `video_structure` text;