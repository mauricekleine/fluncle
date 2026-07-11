-- THE DATA MOVE (the one statement drizzle-kit cannot generate).
-- Migration 0067 created the empty `findings` table; this copies every existing
-- track's CERTIFICATION columns into it, 1:1 by `track_id`, BEFORE the DROP COLUMNs
-- below remove them from `tracks`. It must run here, inside the migration, and not in
-- the deploy's `db:backfill` step: `deploy:cf` runs `db:migrate && db:backfill`, so a
-- backfill would find the columns already gone. Every column named here is derived from
-- this file's own `DROP COLUMN` list, so the copy cannot drift from the drop.
-- The DDL around it is generated (`db:generate`); only this INSERT is authored.
INSERT INTO `findings` (
  track_id, added_at, added_to_spotify, added_to_spotify_at, backfill_discogs_attempted_at,
  backfill_discogs_attempts, backfill_discogs_done_at, backfill_discogs_failures,
  backfill_lastfm_attempted_at, backfill_lastfm_attempts, backfill_lastfm_done_at,
  backfill_lastfm_failures, backfill_note_attempted_at, backfill_note_attempts,
  backfill_note_done_at, backfill_note_failures, context_note, context_status,
  enrichment_status, galaxy_id, log_id, note, observation_alignment_json,
  observation_audio_url, observation_duration_ms, observation_generated_at, observation_script,
  posted_to_telegram, posted_to_telegram_at, spotify_error, telegram_error, updated_at,
  video_grain, video_model, video_model_reasoning, video_register, video_squared_at, video_url,
  video_vehicle
)
SELECT
  track_id, added_at, added_to_spotify, added_to_spotify_at, backfill_discogs_attempted_at,
  backfill_discogs_attempts, backfill_discogs_done_at, backfill_discogs_failures,
  backfill_lastfm_attempted_at, backfill_lastfm_attempts, backfill_lastfm_done_at,
  backfill_lastfm_failures, backfill_note_attempted_at, backfill_note_attempts,
  backfill_note_done_at, backfill_note_failures, context_note, context_status,
  enrichment_status, galaxy_id, log_id, note, observation_alignment_json,
  observation_audio_url, observation_duration_ms, observation_generated_at, observation_script,
  posted_to_telegram, posted_to_telegram_at, spotify_error, telegram_error, updated_at,
  video_grain, video_model, video_model_reasoning, video_register, video_squared_at, video_url,
  video_vehicle
FROM `tracks`;
--> statement-breakpoint
DROP INDEX `tracks_log_id_unique`;--> statement-breakpoint
DROP INDEX `tracks_added_at_track_id_idx`;--> statement-breakpoint
DROP INDEX `tracks_galaxy_id_idx`;--> statement-breakpoint
DROP INDEX `tracks_video_url_idx`;--> statement-breakpoint
DROP INDEX `tracks_enrichment_status_idx`;--> statement-breakpoint
DROP INDEX "account_user_id_idx";--> statement-breakpoint
DROP INDEX "artist_socials_artist_platform_idx";--> statement-breakpoint
DROP INDEX "artist_socials_artist_id_idx";--> statement-breakpoint
DROP INDEX "artist_socials_platform_idx";--> statement-breakpoint
DROP INDEX "artists_slug_unique";--> statement-breakpoint
DROP INDEX "artists_spotify_artist_id_unique";--> statement-breakpoint
DROP INDEX "artists_name_idx";--> statement-breakpoint
DROP INDEX "cost_events_step_occurred_at_idx";--> statement-breakpoint
DROP INDEX "cost_events_track_id_occurred_at_idx";--> statement-breakpoint
DROP INDEX "cost_events_occurred_at_idx";--> statement-breakpoint
DROP INDEX "device_code_device_code_idx";--> statement-breakpoint
DROP INDEX "device_code_user_code_idx";--> statement-breakpoint
DROP INDEX "editions_number_unique";--> statement-breakpoint
DROP INDEX "findings_log_id_unique";--> statement-breakpoint
DROP INDEX "findings_added_at_track_id_idx";--> statement-breakpoint
DROP INDEX "findings_galaxy_id_idx";--> statement-breakpoint
DROP INDEX "findings_video_url_idx";--> statement-breakpoint
DROP INDEX "findings_enrichment_status_idx";--> statement-breakpoint
DROP INDEX "galaxies_handle_unique";--> statement-breakpoint
DROP INDEX "galaxies_slug_unique";--> statement-breakpoint
DROP INDEX "labels_slug_unique";--> statement-breakpoint
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
DROP INDEX "user_email_unique";--> statement-breakpoint
DROP INDEX "user_username_unique";--> statement-breakpoint
DROP INDEX "user_data_exports_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_deletion_requests_user_requested_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_track_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_user_first_idx";--> statement-breakpoint
DROP INDEX "user_galaxy_collections_track_first_idx";--> statement-breakpoint
DROP INDEX "user_saved_findings_user_track_idx";--> statement-breakpoint
DROP INDEX "verification_identifier_idx";--> statement-breakpoint
ALTER TABLE `tracks` ALTER COLUMN "spotify_uri" TO "spotify_uri" text;--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artist_socials_artist_platform_idx` ON `artist_socials` (`artist_id`,`platform`);--> statement-breakpoint
CREATE INDEX `artist_socials_artist_id_idx` ON `artist_socials` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_socials_platform_idx` ON `artist_socials` (`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_slug_unique` ON `artists` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_spotify_artist_id_unique` ON `artists` (`spotify_artist_id`);--> statement-breakpoint
CREATE INDEX `artists_name_idx` ON `artists` (`name`);--> statement-breakpoint
CREATE INDEX `cost_events_step_occurred_at_idx` ON `cost_events` (`step`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_track_id_occurred_at_idx` ON `cost_events` (`track_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_occurred_at_idx` ON `cost_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `device_code_device_code_idx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE INDEX `device_code_user_code_idx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `editions_number_unique` ON `editions` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_log_id_unique` ON `findings` (`log_id`);--> statement-breakpoint
CREATE INDEX `findings_added_at_track_id_idx` ON `findings` (`added_at`,`track_id`);--> statement-breakpoint
CREATE INDEX `findings_galaxy_id_idx` ON `findings` (`galaxy_id`);--> statement-breakpoint
CREATE INDEX `findings_video_url_idx` ON `findings` (`video_url`);--> statement-breakpoint
CREATE INDEX `findings_enrichment_status_idx` ON `findings` (`enrichment_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_handle_unique` ON `galaxies` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_slug_unique` ON `galaxies` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `labels_slug_unique` ON `labels` (`slug`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE INDEX `user_data_exports_user_requested_idx` ON `user_data_exports` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `user_deletion_requests_user_requested_idx` ON `user_deletion_requests` (`user_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_galaxy_collections_user_track_idx` ON `user_galaxy_collections` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_user_first_idx` ON `user_galaxy_collections` (`user_id`,`first_collected_at`);--> statement-breakpoint
CREATE INDEX `user_galaxy_collections_track_first_idx` ON `user_galaxy_collections` (`track_id`,`first_collected_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_saved_findings_user_track_idx` ON `user_saved_findings` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
ALTER TABLE `tracks` ALTER COLUMN "spotify_url" TO "spotify_url" text;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `added_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `added_to_spotify`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `added_to_spotify_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_discogs_attempted_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_discogs_attempts`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_discogs_done_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_discogs_failures`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_lastfm_attempted_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_lastfm_attempts`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_lastfm_done_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_lastfm_failures`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_note_attempted_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_note_attempts`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_note_done_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `backfill_note_failures`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `context_note`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `context_status`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `enrichment_status`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `galaxy_id`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `log_id`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `note`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `observation_alignment_json`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `observation_audio_url`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `observation_duration_ms`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `observation_generated_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `observation_script`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `posted_to_telegram`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `posted_to_telegram_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `spotify_error`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `telegram_error`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `updated_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_grain`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_model`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_model_reasoning`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_register`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_squared_at`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_url`;--> statement-breakpoint
ALTER TABLE `tracks` DROP COLUMN `video_vehicle`;