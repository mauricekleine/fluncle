ALTER TABLE `albums` ADD `apple_album_id` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_bg_color` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_height` integer;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_text_color1` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_text_color2` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_text_color3` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_text_color4` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_url_template` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `artwork_width` integer;--> statement-breakpoint
ALTER TABLE `albums` ADD `record_label_raw` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `upc` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_apple_music_attempted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_apple_music_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_apple_music_done_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `backfill_apple_music_failures` integer DEFAULT 0 NOT NULL;