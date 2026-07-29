ALTER TABLE `tracks` ADD `backfill_discogs_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_discogs_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_discogs_done_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_discogs_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `isrc_attempted_at` text;