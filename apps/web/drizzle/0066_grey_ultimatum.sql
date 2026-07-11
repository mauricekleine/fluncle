CREATE INDEX `tracks_added_at_track_id_idx` ON `tracks` (`added_at`,`track_id`);--> statement-breakpoint
CREATE INDEX `tracks_galaxy_id_idx` ON `tracks` (`galaxy_id`);--> statement-breakpoint
CREATE INDEX `tracks_video_url_idx` ON `tracks` (`video_url`);--> statement-breakpoint
CREATE INDEX `tracks_enrichment_status_idx` ON `tracks` (`enrichment_status`);