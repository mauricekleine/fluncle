DROP INDEX `frontier_editions_user_number_desc_idx`;--> statement-breakpoint
DROP INDEX "account_user_id_idx";--> statement-breakpoint
DROP INDEX "albums_slug_unique";--> statement-breakpoint
DROP INDEX "albums_release_group_mbid_idx";--> statement-breakpoint
DROP INDEX "artist_socials_artist_platform_idx";--> statement-breakpoint
DROP INDEX "artist_socials_unreviewed_idx";--> statement-breakpoint
DROP INDEX "artist_socials_artist_id_idx";--> statement-breakpoint
DROP INDEX "artist_socials_platform_idx";--> statement-breakpoint
DROP INDEX "artists_slug_unique";--> statement-breakpoint
DROP INDEX "artists_spotify_artist_id_unique";--> statement-breakpoint
DROP INDEX "artists_name_idx";--> statement-breakpoint
DROP INDEX "cost_events_step_occurred_at_idx";--> statement-breakpoint
DROP INDEX "cost_events_track_id_occurred_at_idx";--> statement-breakpoint
DROP INDEX "cost_events_occurred_at_idx";--> statement-breakpoint
DROP INDEX "crawl_frontier_pick_idx";--> statement-breakpoint
DROP INDEX "crawl_frontier_label_idx";--> statement-breakpoint
DROP INDEX "device_code_device_code_idx";--> statement-breakpoint
DROP INDEX "device_code_user_code_idx";--> statement-breakpoint
DROP INDEX "editions_number_unique";--> statement-breakpoint
DROP INDEX "findings_log_id_unique";--> statement-breakpoint
DROP INDEX "findings_added_at_track_id_idx";--> statement-breakpoint
DROP INDEX "findings_galaxy_id_idx";--> statement-breakpoint
DROP INDEX "findings_video_url_idx";--> statement-breakpoint
DROP INDEX "findings_enrichment_status_idx";--> statement-breakpoint
DROP INDEX "frontier_edition_tracks_edition_position_idx";--> statement-breakpoint
DROP INDEX "frontier_edition_tracks_edition_id_idx";--> statement-breakpoint
DROP INDEX "frontier_editions_user_number_idx";--> statement-breakpoint
DROP INDEX "galaxies_handle_unique";--> statement-breakpoint
DROP INDEX "galaxies_slug_unique";--> statement-breakpoint
DROP INDEX "label_aliases_label_slug_source_idx";--> statement-breakpoint
DROP INDEX "label_aliases_alias_slug_idx";--> statement-breakpoint
DROP INDEX "label_aliases_status_idx";--> statement-breakpoint
DROP INDEX "labels_slug_unique";--> statement-breakpoint
DROP INDEX "labels_mb_label_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_clip_social_posts_clip_platform_idx";--> statement-breakpoint
DROP INDEX "mixtape_clip_social_posts_status_idx";--> statement-breakpoint
DROP INDEX "mixtape_clips_recording_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_social_posts_mixtape_platform_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_position_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_track_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_finding_id_idx";--> statement-breakpoint
DROP INDEX "mixtapes_log_id_unique";--> statement-breakpoint
DROP INDEX "mixtapes_sequence_number_unique";--> statement-breakpoint
DROP INDEX "mixtapes_recording_id_idx";--> statement-breakpoint
DROP INDEX "note_rejections_open_track_idx";--> statement-breakpoint
DROP INDEX "note_rejections_open_idx";--> statement-breakpoint
DROP INDEX "observation_rejections_open_track_idx";--> statement-breakpoint
DROP INDEX "observation_rejections_open_idx";--> statement-breakpoint
DROP INDEX "platform_stats_platform_metric_captured_at_idx";--> statement-breakpoint
DROP INDEX "prompt_versions_slug_version_idx";--> statement-breakpoint
DROP INDEX "push_receipts_created_at_idx";--> statement-breakpoint
DROP INDEX "push_tokens_user_id_idx";--> statement-breakpoint
DROP INDEX "push_tokens_last_seen_at_idx";--> statement-breakpoint
DROP INDEX "rate_limit_counter_action_bucket_window_idx";--> statement-breakpoint
DROP INDEX "rate_limit_action_bucket_created_at_idx";--> statement-breakpoint
DROP INDEX "rate_limit_user_action_created_at_idx";--> statement-breakpoint
DROP INDEX "rate_limit_ip_action_created_at_idx";--> statement-breakpoint
DROP INDEX "recording_cues_recording_position_idx";--> statement-breakpoint
DROP INDEX "recording_cues_recording_id_idx";--> statement-breakpoint
DROP INDEX "recording_cues_finding_id_idx";--> statement-breakpoint
DROP INDEX "recordings_parent_id_idx";--> statement-breakpoint
DROP INDEX "recordings_parent_version_idx";--> statement-breakpoint
DROP INDEX "service_check_samples_service_at_idx";--> statement-breakpoint
DROP INDEX "session_token_unique";--> statement-breakpoint
DROP INDEX "session_user_id_idx";--> statement-breakpoint
DROP INDEX "social_posts_track_platform_idx";--> statement-breakpoint
DROP INDEX "status_events_at_idx";--> statement-breakpoint
DROP INDEX "submissions_status_created_at_idx";--> statement-breakpoint
DROP INDEX "submissions_spotify_track_id_idx";--> statement-breakpoint
DROP INDEX "submissions_submitter_hash_created_at_idx";--> statement-breakpoint
DROP INDEX "submissions_user_id_created_at_idx";--> statement-breakpoint
DROP INDEX "track_artists_track_id_idx";--> statement-breakpoint
DROP INDEX "track_artists_artist_id_idx";--> statement-breakpoint
DROP INDEX "tracks_album_id_idx";--> statement-breakpoint
DROP INDEX "tracks_label_id_idx";--> statement-breakpoint
DROP INDEX "tracks_release_date_idx";--> statement-breakpoint
DROP INDEX "tracks_nearest_finding_score_idx";--> statement-breakpoint
DROP INDEX "tracks_capture_priority_idx";--> statement-breakpoint
DROP INDEX "tracks_source_audio_attempted_at_idx";--> statement-breakpoint
DROP INDEX "tracks_isrc_idx";--> statement-breakpoint
DROP INDEX "tracks_anchor_queue_idx";--> statement-breakpoint
DROP INDEX "tracks_embed_queue_idx";--> statement-breakpoint
DROP INDEX "tracks_dismissed_idx";--> statement-breakpoint
DROP INDEX "tracks_key_idx";--> statement-breakpoint
DROP INDEX "user_crew_number_unique";--> statement-breakpoint
DROP INDEX "user_email_unique";--> statement-breakpoint
DROP INDEX "user_username_unique";--> statement-breakpoint
DROP INDEX "user_data_exports_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_deletion_requests_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_track_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_first_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_track_first_idx";--> statement-breakpoint
DROP INDEX "user_rec_seeds_user_idx";--> statement-breakpoint
DROP INDEX "user_saved_findings_user_track_idx";--> statement-breakpoint
DROP INDEX "user_saved_sets_user_updated_idx";--> statement-breakpoint
DROP INDEX "verification_identifier_idx";--> statement-breakpoint
ALTER TABLE `user_saved_findings` ALTER COLUMN "log_id" TO "log_id" text;--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `albums_slug_unique` ON `albums` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `albums_release_group_mbid_idx` ON `albums` (`release_group_mbid`);--> statement-breakpoint
CREATE UNIQUE INDEX `artist_socials_artist_platform_idx` ON `artist_socials` (`artist_id`,`platform`);--> statement-breakpoint
CREATE INDEX `artist_socials_unreviewed_idx` ON `artist_socials` (`reviewed_at`);--> statement-breakpoint
CREATE INDEX `artist_socials_artist_id_idx` ON `artist_socials` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_socials_platform_idx` ON `artist_socials` (`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_slug_unique` ON `artists` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_spotify_artist_id_unique` ON `artists` (`spotify_artist_id`);--> statement-breakpoint
CREATE INDEX `artists_name_idx` ON `artists` (`name`);--> statement-breakpoint
CREATE INDEX `cost_events_step_occurred_at_idx` ON `cost_events` (`step`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_track_id_occurred_at_idx` ON `cost_events` (`track_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_occurred_at_idx` ON `cost_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `crawl_frontier_pick_idx` ON `crawl_frontier` (`state`,`hop`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `crawl_frontier_label_idx` ON `crawl_frontier` (`label_slug`);--> statement-breakpoint
CREATE INDEX `device_code_device_code_idx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE INDEX `device_code_user_code_idx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_number_unique` ON `editions` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_log_id_unique` ON `findings` (`log_id`);--> statement-breakpoint
CREATE INDEX `findings_added_at_track_id_idx` ON `findings` (`added_at`,`track_id`);--> statement-breakpoint
CREATE INDEX `findings_galaxy_id_idx` ON `findings` (`galaxy_id`);--> statement-breakpoint
CREATE INDEX `findings_video_url_idx` ON `findings` (`video_url`);--> statement-breakpoint
CREATE INDEX `findings_enrichment_status_idx` ON `findings` (`enrichment_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `frontier_edition_tracks_edition_position_idx` ON `frontier_edition_tracks` (`edition_id`,`position`);--> statement-breakpoint
CREATE INDEX `frontier_edition_tracks_edition_id_idx` ON `frontier_edition_tracks` (`edition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `frontier_editions_user_number_idx` ON `frontier_editions` (`user_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_handle_unique` ON `galaxies` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_slug_unique` ON `galaxies` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `label_aliases_label_slug_source_idx` ON `label_aliases` (`label_id`,`alias_slug`,`source`);--> statement-breakpoint
CREATE INDEX `label_aliases_alias_slug_idx` ON `label_aliases` (`alias_slug`);--> statement-breakpoint
CREATE INDEX `label_aliases_status_idx` ON `label_aliases` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `labels_slug_unique` ON `labels` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `labels_mb_label_id_idx` ON `labels` (`mb_label_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_clip_social_posts_clip_platform_idx` ON `mixtape_clip_social_posts` (`clip_id`,`platform`);--> statement-breakpoint
CREATE INDEX `mixtape_clip_social_posts_status_idx` ON `mixtape_clip_social_posts` (`status`);--> statement-breakpoint
CREATE INDEX `mixtape_clips_recording_id_idx` ON `mixtape_clips` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_social_posts_mixtape_platform_idx` ON `mixtape_social_posts` (`mixtape_id`,`platform`);--> statement-breakpoint
CREATE INDEX `mixtape_tracks_mixtape_id_idx` ON `mixtape_tracks` (`mixtape_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_position_idx` ON `mixtape_tracks` (`mixtape_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_track_idx` ON `mixtape_tracks` (`mixtape_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `mixtape_tracks_finding_id_idx` ON `mixtape_tracks` (`finding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_log_id_unique` ON `mixtapes` (`log_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_sequence_number_unique` ON `mixtapes` (`sequence_number`);--> statement-breakpoint
CREATE INDEX `mixtapes_recording_id_idx` ON `mixtapes` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `note_rejections_open_track_idx` ON `note_rejections` (`track_id`) WHERE "note_rejections"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `note_rejections_open_idx` ON `note_rejections` (`resolved_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `observation_rejections_open_track_idx` ON `observation_rejections` (`track_id`) WHERE "observation_rejections"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `observation_rejections_open_idx` ON `observation_rejections` (`resolved_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `platform_stats_platform_metric_captured_at_idx` ON `platform_stats` (`platform`,`metric`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_versions_slug_version_idx` ON `prompt_versions` (`slug`,`version`);--> statement-breakpoint
CREATE INDEX `push_receipts_created_at_idx` ON `push_receipts` (`created_at`);--> statement-breakpoint
CREATE INDEX `push_tokens_user_id_idx` ON `push_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_tokens_last_seen_at_idx` ON `push_tokens` (`last_seen_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_counter_action_bucket_window_idx` ON `rate_limit_counters` (`action`,`bucket`,`window_start`);--> statement-breakpoint
CREATE INDEX `rate_limit_action_bucket_created_at_idx` ON `rate_limit_events` (`action`,`bucket`,`created_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_user_action_created_at_idx` ON `rate_limit_events` (`user_id`,`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_ip_action_created_at_idx` ON `rate_limit_events` (`ip_hash`,`action`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_cues_recording_position_idx` ON `recording_cues` (`recording_id`,`position`);--> statement-breakpoint
CREATE INDEX `recording_cues_recording_id_idx` ON `recording_cues` (`recording_id`);--> statement-breakpoint
CREATE INDEX `recording_cues_finding_id_idx` ON `recording_cues` (`finding_id`);--> statement-breakpoint
CREATE INDEX `recordings_parent_id_idx` ON `recordings` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_parent_version_idx` ON `recordings` (`parent_id`,`version`);--> statement-breakpoint
CREATE INDEX `service_check_samples_service_at_idx` ON `service_check_samples` (`service`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `social_posts_track_platform_idx` ON `social_posts` (`track_id`,`platform`);--> statement-breakpoint
CREATE INDEX `status_events_at_idx` ON `status_events` (`at`);--> statement-breakpoint
CREATE INDEX `submissions_status_created_at_idx` ON `submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `submissions_spotify_track_id_idx` ON `submissions` (`spotify_track_id`);--> statement-breakpoint
CREATE INDEX `submissions_submitter_hash_created_at_idx` ON `submissions` (`submitter_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `submissions_user_id_created_at_idx` ON `submissions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `track_artists_track_id_idx` ON `track_artists` (`track_id`);--> statement-breakpoint
CREATE INDEX `track_artists_artist_id_idx` ON `track_artists` (`artist_id`);--> statement-breakpoint
CREATE INDEX `tracks_album_id_idx` ON `tracks` (`album_id`);--> statement-breakpoint
CREATE INDEX `tracks_label_id_idx` ON `tracks` (`label_id`);--> statement-breakpoint
CREATE INDEX `tracks_release_date_idx` ON `tracks` (`release_date`);--> statement-breakpoint
CREATE INDEX `tracks_nearest_finding_score_idx` ON `tracks` (`nearest_finding_score`);--> statement-breakpoint
CREATE INDEX `tracks_capture_priority_idx` ON `tracks` (`capture_priority`);--> statement-breakpoint
CREATE INDEX `tracks_source_audio_attempted_at_idx` ON `tracks` (`source_audio_attempted_at`);--> statement-breakpoint
CREATE INDEX `tracks_isrc_idx` ON `tracks` (`isrc`);--> statement-breakpoint
CREATE INDEX `tracks_anchor_queue_idx` ON `tracks` (`isrc`) WHERE "tracks"."spotify_uri" is null and "tracks"."isrc" is not null;--> statement-breakpoint
CREATE INDEX `tracks_embed_queue_idx` ON `tracks` (`track_id`) WHERE "tracks"."source_audio_key" is not null and "tracks"."embedding_blob" is null;--> statement-breakpoint
CREATE INDEX `tracks_dismissed_idx` ON `tracks` (`dismissed_at`) WHERE "tracks"."dismissed_at" is not null;--> statement-breakpoint
CREATE INDEX `tracks_key_idx` ON `tracks` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_crew_number_unique` ON `user` (`crew_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE INDEX `user_data_exports_user_requested_idx` ON `user_data_exports` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `user_deletion_requests_user_requested_idx` ON `user_deletion_requests` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_galaxy_collections_user_track_idx` ON `user_galaxy_collections` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_user_first_idx` ON `user_galaxy_collections` (`user_id`,`first_collected_at`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_track_first_idx` ON `user_galaxy_collections` (`track_id`,`first_collected_at`);--> statement-breakpoint
CREATE INDEX `user_rec_seeds_user_idx` ON `user_rec_seeds` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_saved_findings_user_track_idx` ON `user_saved_findings` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `user_saved_sets_user_updated_idx` ON `user_saved_sets` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);