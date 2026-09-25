ALTER TABLE `tracks` ADD `spotify_anchor_invalid_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tracks` ADD `spotify_anchor_quota_admitted_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `spotify_anchor_terminal_error` text;--> statement-breakpoint
CREATE INDEX `tracks_anchor_prior_order_idx` ON `tracks` (`has_isrc`,`has_embedding`,`nearest_finding_score`,`track_id`) WHERE "tracks"."spotify_uri" is null and "tracks"."spotify_isrc_asked_at" is not null;--> statement-breakpoint
CREATE INDEX `tracks_anchor_terminal_idx` ON `tracks` (`track_id`) WHERE "tracks"."spotify_anchor_terminal_error" is not null;