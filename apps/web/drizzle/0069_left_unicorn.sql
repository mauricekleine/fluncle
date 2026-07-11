ALTER TABLE `tracks` ADD `capture_priority` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `catalogue_rank_corpus` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `catalogue_ranked_at` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `nearest_finding_score` real;--> statement-breakpoint
ALTER TABLE `tracks` ADD `nearest_finding_track_id` text;--> statement-breakpoint
CREATE INDEX `tracks_nearest_finding_score_idx` ON `tracks` (`nearest_finding_score`);--> statement-breakpoint
CREATE INDEX `tracks_capture_priority_idx` ON `tracks` (`capture_priority`);