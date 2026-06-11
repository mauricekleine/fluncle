ALTER TABLE `tracks` ADD `vibe_x` real;--> statement-breakpoint
ALTER TABLE `tracks` ADD `vibe_y` real;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `tags_json`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `tags_source`;