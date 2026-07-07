CREATE TABLE `subscriptions` (
	`amount` integer NOT NULL,
	`billing_url` text,
	`cadence` text NOT NULL,
	`category` text NOT NULL,
	`created_at` text NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`powers` text,
	`renews_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`updated_at` text NOT NULL,
	`vendor` text NOT NULL
);
