ALTER TABLE `labels` ADD `discogs_label_id` integer;--> statement-breakpoint
ALTER TABLE `labels` ADD `image_attempted_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `image_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `image_key` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `image_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `mb_label_id` text;