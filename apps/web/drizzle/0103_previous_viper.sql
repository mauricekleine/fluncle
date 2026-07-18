CREATE TABLE `frontier_edition_tracks` (
	`artists_text` text NOT NULL,
	`bpm` integer,
	`cover_url` text,
	`duration_ms` integer,
	`edition_id` text NOT NULL,
	`key` text,
	`log_id` text,
	`position` integer NOT NULL,
	`slot` text NOT NULL,
	`spotify_uri` text,
	`spotify_url` text,
	`title_text` text NOT NULL,
	`track_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `frontier_edition_tracks_edition_position_idx` ON `frontier_edition_tracks` (`edition_id`,`position`);--> statement-breakpoint
CREATE INDEX `frontier_edition_tracks_edition_id_idx` ON `frontier_edition_tracks` (`edition_id`);--> statement-breakpoint
CREATE TABLE `frontier_editions` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `frontier_editions_user_number_idx` ON `frontier_editions` (`user_id`,`number`);--> statement-breakpoint
CREATE INDEX `frontier_editions_user_number_desc_idx` ON `frontier_editions` (`user_id`,"number" desc);