ALTER TABLE `tracks` ADD `isrc` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `label` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `log_id` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `popularity` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `preview_url` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `tags_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_log_id_unique` ON `tracks` (`log_id`);