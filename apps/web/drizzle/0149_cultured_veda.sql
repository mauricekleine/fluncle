DROP INDEX `tracks_anchor_order_idx`;--> statement-breakpoint
ALTER TABLE `tracks` ADD `has_isrc` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `tracks_anchor_order_idx` ON `tracks` (`has_isrc`,`has_embedding`,`nearest_finding_score`,`track_id`) WHERE "tracks"."spotify_uri" is null;