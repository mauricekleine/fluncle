CREATE TABLE `prompt_versions` (
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text DEFAULT 'operator' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`note` text,
	`slug` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_versions_slug_version_idx` ON `prompt_versions` (`slug`,`version`);--> statement-breakpoint
ALTER TABLE `editions` ADD `prompt_version` integer;--> statement-breakpoint
ALTER TABLE `findings` ADD `context_prompt_version` integer;--> statement-breakpoint
ALTER TABLE `findings` ADD `note_prompt_version` integer;--> statement-breakpoint
ALTER TABLE `findings` ADD `observation_prompt_version` integer;--> statement-breakpoint
ALTER TABLE `logbook_entries` ADD `prompt_version` integer;--> statement-breakpoint
ALTER TABLE `submissions` ADD `triage_prompt_version` integer;