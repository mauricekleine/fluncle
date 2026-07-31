ALTER TABLE `tracks` ADD `backfill_deezer_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_deezer_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_deezer_done_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_deezer_failures` integer DEFAULT 0 NOT NULL;