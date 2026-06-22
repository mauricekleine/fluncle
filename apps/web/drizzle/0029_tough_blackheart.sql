CREATE TABLE `radio_schedule` (
	`epoch_ms` integer NOT NULL,
	`generated_at` text NOT NULL,
	`service` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL
);
