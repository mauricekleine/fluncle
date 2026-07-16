CREATE TABLE `user_rec_seeds` (
	`added_at` text NOT NULL,
	`track_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `track_id`)
);
--> statement-breakpoint
CREATE INDEX `user_rec_seeds_user_idx` ON `user_rec_seeds` (`user_id`);