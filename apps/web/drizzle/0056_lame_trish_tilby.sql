CREATE TABLE `exchange_rates` (
	`base` text PRIMARY KEY NOT NULL,
	`fetched_at` text NOT NULL,
	`rates_date` text NOT NULL,
	`rates_json` text NOT NULL
);
