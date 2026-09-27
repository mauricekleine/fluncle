CREATE TABLE `label_outlier_dismissals` (
	`dismissed_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`unit_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `label_outliers` (
	`album_id` text,
	`alerted_at` text,
	`artist_support` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`first_flagged_at` text NOT NULL,
	`label_id` text,
	`reference` text NOT NULL,
	`reference_median` real NOT NULL,
	`score` real NOT NULL,
	`single_track_id` text,
	`track_count` integer NOT NULL,
	`unit_id` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	`z` real NOT NULL
);
