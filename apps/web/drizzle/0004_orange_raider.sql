ALTER TABLE `tracks` ADD `bpm` real;--> statement-breakpoint
ALTER TABLE `tracks` ADD `enrichment_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `key` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `tags_source` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `video_url` text;