CREATE TABLE `artist_socials` (
	`artist_id` text NOT NULL,
	`created_at` text NOT NULL,
	`followed_at` text,
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`url` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artist_socials_artist_platform_idx` ON `artist_socials` (`artist_id`,`platform`);--> statement-breakpoint
CREATE INDEX `artist_socials_artist_id_idx` ON `artist_socials` (`artist_id`);--> statement-breakpoint
CREATE INDEX `artist_socials_platform_idx` ON `artist_socials` (`platform`);--> statement-breakpoint
CREATE TABLE `artists` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mbid` text,
	`name` text NOT NULL,
	`resolved_at` text,
	`slug` text NOT NULL,
	`spotify_artist_id` text,
	`spotify_url` text,
	`updated_at` text NOT NULL,
	`wikidata_qid` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_slug_unique` ON `artists` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_spotify_artist_id_unique` ON `artists` (`spotify_artist_id`);--> statement-breakpoint
CREATE INDEX `artists_name_idx` ON `artists` (`name`);--> statement-breakpoint
CREATE TABLE `track_artists` (
	`artist_id` text NOT NULL,
	`position` integer NOT NULL,
	`track_id` text NOT NULL,
	PRIMARY KEY(`track_id`, `artist_id`)
);
--> statement-breakpoint
CREATE INDEX `track_artists_track_id_idx` ON `track_artists` (`track_id`);--> statement-breakpoint
CREATE INDEX `track_artists_artist_id_idx` ON `track_artists` (`artist_id`);