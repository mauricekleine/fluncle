CREATE INDEX `findings_render_queue_idx` ON `findings` (`added_at`,`track_id`) WHERE "findings"."video_url" is null;--> statement-breakpoint
CREATE INDEX `findings_video_squared_at_idx` ON `findings` (`video_squared_at`) WHERE "findings"."video_url" is not null;--> statement-breakpoint
CREATE INDEX `labels_undecided_queue_idx` ON `labels` (`created_at`) WHERE "labels"."seed_state" = 'undecided';--> statement-breakpoint
CREATE INDEX `labels_seed_state_name_idx` ON `labels` (`seed_state`,"name" collate nocase);--> statement-breakpoint
CREATE INDEX `mixtape_tracks_track_id_idx` ON `mixtape_tracks` (`track_id`);--> statement-breakpoint
CREATE INDEX `tracks_capture_priority_track_id_idx` ON `tracks` (`capture_priority`,`track_id`) WHERE "tracks"."capture_priority" is not null;