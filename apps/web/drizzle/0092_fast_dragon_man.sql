CREATE TABLE `observation_rejections` (
	`attempts` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`max_overlap` real NOT NULL,
	`min_phrase_words` integer NOT NULL,
	`neighbor_log_id` text,
	`neighbor_script` text,
	`overlap` real NOT NULL,
	`phrase` text DEFAULT '' NOT NULL,
	`resolution` text,
	`resolved_at` text,
	`script` text NOT NULL,
	`track_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_rejections_open_track_idx` ON `observation_rejections` (`track_id`) WHERE "observation_rejections"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `observation_rejections_open_idx` ON `observation_rejections` (`resolved_at`,`created_at`);