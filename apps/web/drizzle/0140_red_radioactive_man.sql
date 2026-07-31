ALTER TABLE `tracks` ADD `backfill_beatport_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_beatport_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_beatport_done_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_beatport_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `beatport_url` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `beatport_verified_at` text;