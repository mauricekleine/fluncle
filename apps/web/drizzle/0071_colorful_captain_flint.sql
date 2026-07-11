CREATE TABLE `crawl_frontier` (
	`attempted_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`done_at` text,
	`external_id` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`hop` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label_slug` text,
	`note` text,
	`parent_id` text,
	`source` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crawl_frontier_pick_idx` ON `crawl_frontier` (`state`,`hop`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `crawl_frontier_label_idx` ON `crawl_frontier` (`label_slug`);--> statement-breakpoint
CREATE INDEX `tracks_isrc_idx` ON `tracks` (`isrc`);--> statement-breakpoint
CREATE INDEX `tracks_anchor_queue_idx` ON `tracks` (`isrc`) WHERE "tracks"."spotify_uri" is null and "tracks"."isrc" is not null;