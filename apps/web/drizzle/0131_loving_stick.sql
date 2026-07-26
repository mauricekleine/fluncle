ALTER TABLE `tracks` ADD `anchor_review_json` text;--> statement-breakpoint
CREATE INDEX `tracks_anchor_review_idx` ON `tracks` (`track_id`) WHERE "tracks"."anchor_review_json" is not null;