CREATE TABLE `artist_rules` (
	`artist_mbid` text NOT NULL,
	`artist_name` text NOT NULL,
	`artist_spotify_id` text,
	`checked_at` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`label_id` text,
	`rearmed_at` text,
	`resolved_mbid` text,
	`resolved_name` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL,
	`verdict` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artist_rules_label_artist_idx` ON `artist_rules` (`label_id`,`artist_mbid`) WHERE "artist_rules"."label_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `artist_rules_global_artist_idx` ON `artist_rules` (`artist_mbid`) WHERE "artist_rules"."label_id" is null;--> statement-breakpoint
CREATE INDEX `artist_rules_label_id_idx` ON `artist_rules` (`label_id`);