CREATE TABLE `albums` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `albums_slug_unique` ON `albums` (`slug`);--> statement-breakpoint
ALTER TABLE `tracks` ADD `album_id` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `label_id` text;--> statement-breakpoint
CREATE INDEX `tracks_album_id_idx` ON `tracks` (`album_id`);--> statement-breakpoint
CREATE INDEX `tracks_label_id_idx` ON `tracks` (`label_id`);