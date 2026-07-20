DROP INDEX `labels_apple_probe_queue_idx`;--> statement-breakpoint
ALTER TABLE `labels` DROP COLUMN `apple_label_attempted_at`;--> statement-breakpoint
ALTER TABLE `labels` DROP COLUMN `apple_label_failures`;--> statement-breakpoint
ALTER TABLE `labels` DROP COLUMN `apple_label_id`;--> statement-breakpoint
ALTER TABLE `labels` DROP COLUMN `apple_label_state`;--> statement-breakpoint
ALTER TABLE `labels` DROP COLUMN `apple_releases_checked_at`;