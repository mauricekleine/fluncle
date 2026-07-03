DROP INDEX "account_user_id_idx";--> statement-breakpoint
DROP INDEX "device_code_device_code_idx";--> statement-breakpoint
DROP INDEX "device_code_user_code_idx";--> statement-breakpoint
DROP INDEX "editions_number_unique";--> statement-breakpoint
DROP INDEX "mixtape_clips_mixtape_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_clips_recording_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_social_posts_mixtape_platform_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_id_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_position_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_mixtape_track_idx";--> statement-breakpoint
DROP INDEX "mixtape_tracks_finding_id_idx";--> statement-breakpoint
DROP INDEX "mixtapes_log_id_unique";--> statement-breakpoint
DROP INDEX "mixtapes_sequence_number_unique";--> statement-breakpoint
DROP INDEX "mixtapes_recording_id_idx";--> statement-breakpoint
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
DROP INDEX "tracks_log_id_unique";--> statement-breakpoint
DROP INDEX "user_email_unique";--> statement-breakpoint
DROP INDEX "user_username_unique";--> statement-breakpoint
DROP INDEX "user_data_exports_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_deletion_requests_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_track_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_first_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_track_first_idx";--> statement-breakpoint
DROP INDEX "user_saved_findings_user_track_idx";--> statement-breakpoint
DROP INDEX "verification_identifier_idx";--> statement-breakpoint
ALTER TABLE `mixtape_clips` ALTER COLUMN "mixtape_id" TO "mixtape_id" text;--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `device_code_device_code_idx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE INDEX `device_code_user_code_idx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_number_unique` ON `editions` (`number`);--> statement-breakpoint
CREATE INDEX `mixtape_clips_mixtape_id_idx` ON `mixtape_clips` (`mixtape_id`);--> statement-breakpoint
CREATE INDEX `mixtape_clips_recording_id_idx` ON `mixtape_clips` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_social_posts_mixtape_platform_idx` ON `mixtape_social_posts` (`mixtape_id`,`platform`);--> statement-breakpoint
CREATE INDEX `mixtape_tracks_mixtape_id_idx` ON `mixtape_tracks` (`mixtape_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_position_idx` ON `mixtape_tracks` (`mixtape_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtape_tracks_mixtape_track_idx` ON `mixtape_tracks` (`mixtape_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `mixtape_tracks_finding_id_idx` ON `mixtape_tracks` (`finding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_log_id_unique` ON `mixtapes` (`log_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mixtapes_sequence_number_unique` ON `mixtapes` (`sequence_number`);--> statement-breakpoint
CREATE INDEX `mixtapes_recording_id_idx` ON `mixtapes` (`recording_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `tracks_log_id_unique` ON `tracks` (`log_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE INDEX `user_data_exports_user_requested_idx` ON `user_data_exports` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `user_deletion_requests_user_requested_idx` ON `user_deletion_requests` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_galaxy_collections_user_track_idx` ON `user_galaxy_collections` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_user_first_idx` ON `user_galaxy_collections` (`user_id`,`first_collected_at`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_track_first_idx` ON `user_galaxy_collections` (`track_id`,`first_collected_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_saved_findings_user_track_idx` ON `user_saved_findings` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
ALTER TABLE `recordings` ALTER COLUMN "r2_key" TO "r2_key" text;