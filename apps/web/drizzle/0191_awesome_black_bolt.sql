CREATE TABLE `user_follow_digests` (
	`last_release_count` integer,
	`last_sent_at` text,
	`last_week_key` text,
	`unsubscribed_at` text,
	`updated_at` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL
);
