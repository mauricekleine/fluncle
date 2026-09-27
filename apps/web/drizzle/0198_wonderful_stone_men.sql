CREATE TABLE `crawl_release_holds` (
	`artists` text NOT NULL,
	`created_at` text NOT NULL,
	`label_id` text NOT NULL,
	`rearmed_at` text,
	`reason` text NOT NULL,
	`release_date` text,
	`release_mbid` text PRIMARY KEY NOT NULL,
	`release_title` text,
	`ruled_at` text,
	`state` text DEFAULT 'held' NOT NULL,
	`threshold_year` integer NOT NULL,
	`track_count` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crawl_release_holds_state_idx` ON `crawl_release_holds` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `crawl_release_holds_label_id_idx` ON `crawl_release_holds` (`label_id`);--> statement-breakpoint
CREATE INDEX `crawl_release_holds_rearm_idx` ON `crawl_release_holds` (`release_mbid`) WHERE "crawl_release_holds"."state" = 'released' and "crawl_release_holds"."rearmed_at" is null;