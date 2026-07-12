ALTER TABLE `findings` ADD `backfill_apple_music_attempted_at` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `backfill_apple_music_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `findings` ADD `backfill_apple_music_done_at` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `backfill_apple_music_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `apple_music_url` text;