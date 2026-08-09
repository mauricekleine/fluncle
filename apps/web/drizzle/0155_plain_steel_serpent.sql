DROP INDEX `tracks_fresh_catalogue_idx`;--> statement-breakpoint
CREATE INDEX `tracks_fresh_catalogue_idx` ON `tracks` (`is_catalogue`,`release_date`,`track_id`);