ALTER TABLE `labels` ADD `founded_location` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `founding_date` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `lineage_attempted_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `lineage_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `lineage_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `parent_label_id` text;--> statement-breakpoint
CREATE INDEX `labels_parent_label_id_idx` ON `labels` (`parent_label_id`);--> statement-breakpoint
CREATE INDEX `labels_lineage_queue_idx` ON `labels` (`slug`) WHERE "labels"."lineage_state" = 'pending';--> statement-breakpoint
ALTER TABLE `track_artists` ADD `role` text;