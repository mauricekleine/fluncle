CREATE TABLE `submissions` (
	`album` text,
	`artists_json` text NOT NULL,
	`artwork_url` text,
	`contact` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`note` text,
	`reviewed_at` text,
	`source` text NOT NULL,
	`spotify_track_id` text NOT NULL,
	`spotify_url` text NOT NULL,
	`status` text NOT NULL,
	`submitter_hash` text NOT NULL,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submissions_status_created_at_idx` ON `submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `submissions_spotify_track_id_idx` ON `submissions` (`spotify_track_id`);--> statement-breakpoint
CREATE INDEX `submissions_submitter_hash_created_at_idx` ON `submissions` (`submitter_hash`,`created_at`);