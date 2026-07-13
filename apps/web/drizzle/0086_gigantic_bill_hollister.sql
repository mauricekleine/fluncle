ALTER TABLE `tracks` ADD `dismissed_at` text;--> statement-breakpoint
CREATE INDEX `tracks_dismissed_idx` ON `tracks` (`dismissed_at`) WHERE "tracks"."dismissed_at" is not null;