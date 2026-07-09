ALTER TABLE `tracks` ADD `analyzed_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `analyzed_from` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `bpm_confidence` real;--> statement-breakpoint
ALTER TABLE `tracks` ADD `bpm_source` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `key_confidence` real;--> statement-breakpoint
ALTER TABLE `tracks` ADD `key_source` text;