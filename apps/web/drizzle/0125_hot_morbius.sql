ALTER TABLE `tracks` ADD `is_catalogue` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `tracks_is_catalogue_idx` ON `tracks` (`is_catalogue`) WHERE "tracks"."is_catalogue" = 1;