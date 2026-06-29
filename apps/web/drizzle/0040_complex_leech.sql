CREATE TABLE `mixtape_clips` (
	`caption` text,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`in_ms` integer NOT NULL,
	`mixtape_id` text NOT NULL,
	`out_ms` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated_at` text NOT NULL,
	`x_offset` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mixtape_clips_mixtape_id_idx` ON `mixtape_clips` (`mixtape_id`);