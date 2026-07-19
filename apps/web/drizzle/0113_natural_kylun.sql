CREATE TABLE `user_watches` (
	`created_at` text NOT NULL,
	`entity_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`include_similar` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_watches_user_kind_entity_idx` ON `user_watches` (`user_id`,`kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `user_watches_user_created_idx` ON `user_watches` (`user_id`,`created_at`);