CREATE TABLE `live_state` (
	`id` text PRIMARY KEY NOT NULL,
	`live` integer NOT NULL,
	`title` text,
	`started_at` text,
	`tg_message_id` integer,
	`updated_at` text NOT NULL
);
