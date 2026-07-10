CREATE TABLE `galaxies` (
	`centroid_json` text NOT NULL,
	`created_at` text NOT NULL,
	`handle` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`retired_at` text,
	`slug` text,
	`split_requested_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_handle_unique` ON `galaxies` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `galaxies_slug_unique` ON `galaxies` (`slug`);--> statement-breakpoint
ALTER TABLE `tracks` ADD `galaxy_id` text;