CREATE TABLE `recordings` (
	`created_at` text NOT NULL,
	`duration_ms` integer,
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`recorded_at` text,
	`title` text NOT NULL,
	`tracklist_json` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mixtape_clips` ADD `recording_id` text;--> statement-breakpoint
CREATE INDEX `mixtape_clips_recording_id_idx` ON `mixtape_clips` (`recording_id`);--> statement-breakpoint
ALTER TABLE `mixtapes` ADD `recording_id` text;--> statement-breakpoint
CREATE INDEX `mixtapes_recording_id_idx` ON `mixtapes` (`recording_id`);