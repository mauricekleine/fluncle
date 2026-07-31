ALTER TABLE `albums` ADD `discogs_attempted_at` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `discogs_catno` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `discogs_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `albums` ADD `discogs_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `albums` ADD `discogs_styles` text;--> statement-breakpoint
CREATE INDEX `tracks_discogs_release_idx` ON `tracks` (`in_release_id`) WHERE "tracks"."in_release_id" is not null;