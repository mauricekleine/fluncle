ALTER TABLE `albums` ADD `certified_finding_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `albums` ADD `renderable_track_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `albums_renderable_count_idx` ON `albums` (`renderable_track_count`);--> statement-breakpoint
ALTER TABLE `artists` ADD `certified_finding_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artists` ADD `renderable_track_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `artists_renderable_count_idx` ON `artists` (`renderable_track_count`);--> statement-breakpoint
ALTER TABLE `labels` ADD `certified_finding_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `renderable_track_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `labels_renderable_count_idx` ON `labels` (`renderable_track_count`);