CREATE TABLE `user_preferences` (
	`preferences` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL
);
