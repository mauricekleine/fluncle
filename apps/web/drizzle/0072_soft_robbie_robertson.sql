ALTER TABLE `tracks` ADD `source_audio_bytes` integer;--> statement-breakpoint
CREATE INDEX `tracks_source_audio_attempted_at_idx` ON `tracks` (`source_audio_attempted_at`);