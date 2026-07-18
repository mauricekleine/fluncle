ALTER TABLE `frontier_edition_tracks` ADD `similarity` real;--> statement-breakpoint
ALTER TABLE `frontier_editions` ADD `seeds_skipped_json` text;--> statement-breakpoint
ALTER TABLE `frontier_editions` ADD `seeds_used` integer;