ALTER TABLE `labels` ADD `label_releases_attempted_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `label_releases_checked_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `label_releases_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `labels_label_releases_queue_idx` ON `labels` (`label_releases_checked_at`) WHERE "labels"."seed_state" = 'enabled';