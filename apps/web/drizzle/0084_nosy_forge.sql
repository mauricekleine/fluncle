CREATE TABLE `user_saved_sets` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`set_tokens` text NOT NULL,
	`taste` text,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_saved_sets_user_updated_idx` ON `user_saved_sets` (`user_id`,`updated_at`);