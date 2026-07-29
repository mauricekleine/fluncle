ALTER TABLE `tracks` ADD `spotify_anchor_source` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `spotify_anchor_verified_by` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `spotify_anchored_at` text;--> statement-breakpoint
CREATE INDEX `tracks_mb_recording_id_idx` ON `tracks` (`mb_recording_id`);