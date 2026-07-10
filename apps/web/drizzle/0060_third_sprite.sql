CREATE TABLE `logbook_entries` (
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`generated_at` text NOT NULL,
	`generated_by` text DEFAULT 'agent' NOT NULL,
	`sector` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
