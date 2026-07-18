CREATE TABLE `artist_aliases` (
	`alias` text NOT NULL,
	`alias_slug` text NOT NULL,
	`artist_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artist_aliases_artist_slug_source_idx` ON `artist_aliases` (`artist_id`,`alias_slug`,`source`);--> statement-breakpoint
CREATE INDEX `artist_aliases_artist_id_idx` ON `artist_aliases` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_aliases_alias_slug_idx` ON `artist_aliases` (`alias_slug`);--> statement-breakpoint
ALTER TABLE `tracks` ADD `mb_recording_id` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `mb_recording_id_attempted_at` text;--> statement-breakpoint
CREATE INDEX `tracks_mb_recording_id_queue_idx` ON `tracks` (`track_id`) WHERE "tracks"."mb_recording_id" is null and "tracks"."mb_recording_id_attempted_at" is null;