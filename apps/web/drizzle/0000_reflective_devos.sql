CREATE TABLE `spotify_auth` (
	`service` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`scope` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`track_id` text PRIMARY KEY NOT NULL,
	`spotify_url` text NOT NULL,
	`spotify_uri` text NOT NULL,
	`title` text NOT NULL,
	`artists_json` text NOT NULL,
	`album` text,
	`duration_ms` integer NOT NULL,
	`note` text,
	`added_at` text NOT NULL,
	`added_to_spotify` integer DEFAULT false NOT NULL,
	`added_to_spotify_at` text,
	`spotify_error` text,
	`posted_to_telegram` integer DEFAULT false NOT NULL,
	`posted_to_telegram_at` text,
	`telegram_error` text
);
