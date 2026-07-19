ALTER TABLE `labels` ADD `apple_label_attempted_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `apple_label_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `apple_label_id` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `apple_label_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `apple_releases_checked_at` text;--> statement-breakpoint
CREATE INDEX `labels_apple_probe_queue_idx` ON `labels` (`apple_releases_checked_at`) WHERE "labels"."seed_state" = 'enabled';