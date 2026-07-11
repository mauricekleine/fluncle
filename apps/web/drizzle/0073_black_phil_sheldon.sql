CREATE TABLE `note_rejections` (
	`attempts` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`max_overlap` real NOT NULL,
	`min_phrase_words` integer NOT NULL,
	`neighbor_log_id` text,
	`neighbor_note` text,
	`note` text NOT NULL,
	`overlap` real NOT NULL,
	`phrase` text DEFAULT '' NOT NULL,
	`resolution` text,
	`resolved_at` text,
	`track_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_rejections_open_track_idx` ON `note_rejections` (`track_id`) WHERE "note_rejections"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `note_rejections_open_idx` ON `note_rejections` (`resolved_at`,`created_at`);