ALTER TABLE `tracks` ADD `artist_credits_backfilled_at` text;--> statement-breakpoint
CREATE INDEX `tracks_artist_credits_backfill_queue_idx` ON `tracks` (`track_id`) WHERE "tracks"."artist_credits_backfilled_at" is null and "tracks"."artist_edges_backfilled_at" is not null;--> statement-breakpoint
CREATE INDEX `artists_mbid_idx` ON `artists` (`mbid`);