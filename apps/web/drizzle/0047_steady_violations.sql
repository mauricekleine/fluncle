CREATE TABLE `live_state` (
	`id` text PRIMARY KEY NOT NULL,
	`live` integer NOT NULL,
	`started_at` text,
	`tg_message_id` integer,
	`title` text,
	`updated_at` text NOT NULL
);
