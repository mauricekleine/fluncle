CREATE TABLE `findings` (
	`added_at` text NOT NULL,
	`added_to_spotify` integer DEFAULT false NOT NULL,
	`added_to_spotify_at` text,
	`backfill_discogs_attempted_at` text,
	`backfill_discogs_attempts` integer DEFAULT 0 NOT NULL,
	`backfill_discogs_done_at` text,
	`backfill_discogs_failures` integer DEFAULT 0 NOT NULL,
	`backfill_lastfm_attempted_at` text,
	`backfill_lastfm_attempts` integer DEFAULT 0 NOT NULL,
	`backfill_lastfm_done_at` text,
	`backfill_lastfm_failures` integer DEFAULT 0 NOT NULL,
	`backfill_note_attempted_at` text,
	`backfill_note_attempts` integer DEFAULT 0 NOT NULL,
	`backfill_note_done_at` text,
	`backfill_note_failures` integer DEFAULT 0 NOT NULL,
	`context_note` text,
	`context_status` text,
	`enrichment_status` text DEFAULT 'pending' NOT NULL,
	`galaxy_id` text,
	`log_id` text,
	`note` text,
	`observation_alignment_json` text,
	`observation_audio_url` text,
	`observation_duration_ms` integer,
	`observation_generated_at` text,
	`observation_script` text,
	`posted_to_telegram` integer DEFAULT false NOT NULL,
	`posted_to_telegram_at` text,
	`spotify_error` text,
	`telegram_error` text,
	`track_id` text PRIMARY KEY NOT NULL,
	`updated_at` text,
	`video_grain` text,
	`video_model` text DEFAULT 'anthropic/claude-opus-4-8',
	`video_model_reasoning` text DEFAULT 'high',
	`video_register` text,
	`video_squared_at` text,
	`video_url` text,
	`video_vehicle` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_log_id_unique` ON `findings` (`log_id`);--> statement-breakpoint
CREATE INDEX `findings_added_at_track_id_idx` ON `findings` (`added_at`,`track_id`);--> statement-breakpoint
CREATE INDEX `findings_galaxy_id_idx` ON `findings` (`galaxy_id`);--> statement-breakpoint
CREATE INDEX `findings_video_url_idx` ON `findings` (`video_url`);--> statement-breakpoint
CREATE INDEX `findings_enrichment_status_idx` ON `findings` (`enrichment_status`);