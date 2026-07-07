ALTER TABLE `tracks` ADD `capture_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `source_audio_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `source_audio_captured_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `source_audio_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `source_audio_key` text;