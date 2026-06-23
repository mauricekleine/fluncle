ALTER TABLE `tracks` ADD `backfill_note_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_note_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_note_done_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_note_failures` integer DEFAULT 0 NOT NULL;