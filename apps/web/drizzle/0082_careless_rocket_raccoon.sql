CREATE TABLE `label_aliases` (
	`alias` text NOT NULL,
	`alias_slug` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_aliases_label_slug_source_idx` ON `label_aliases` (`label_id`,`alias_slug`,`source`);--> statement-breakpoint
CREATE INDEX `label_aliases_alias_slug_idx` ON `label_aliases` (`alias_slug`);--> statement-breakpoint
CREATE INDEX `label_aliases_status_idx` ON `label_aliases` (`status`);