ALTER TABLE `albums` ADD `image_attempted_at` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `image_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `albums` ADD `image_key` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `image_source` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `image_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `albums` ADD `image_updated_at` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_attempted_at` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_key` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_source` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `artists` ADD `image_updated_at` text;