CREATE TABLE `mixtape_tracks` (
	`mixtape_id` text NOT NULL,
	`position` integer NOT NULL,
	`track_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mixtape_tracks_mixtape_id_idx` ON `mixtape_tracks` (`mixtape_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_position_idx` ON `mixtape_tracks` (`mixtape_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_track_idx` ON `mixtape_tracks` (`mixtape_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `mixtapes` (
	`added_at` text,
	`cover_image_url` text,
	`created_at` text NOT NULL,
	`duration_ms` integer,
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text,
	`mixcloud_url` text,
	`note` text,
	`published_at` text,
	`recorded_at` text,
	`sequence_number` integer,
	`soundcloud_url` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	`youtube_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_log_id_unique` ON `mixtapes` (`log_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_sequence_number_unique` ON `mixtapes` (`sequence_number`);