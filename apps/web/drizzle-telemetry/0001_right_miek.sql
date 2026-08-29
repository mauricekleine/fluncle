ALTER TABLE `run_events` ADD `access_class` text;--> statement-breakpoint
ALTER TABLE `run_events` ADD `attempt_count` integer;--> statement-breakpoint
ALTER TABLE `run_events` ADD `batch_count` integer;--> statement-breakpoint
ALTER TABLE `run_events` ADD `operation_id` text;--> statement-breakpoint
ALTER TABLE `run_events` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `run_events` ADD `release` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- Authored data move: drizzle-kit cannot derive the new outcome from the existing authoritative ok verdict.
UPDATE `run_events` SET `outcome` = CASE WHEN `ok` = 1 THEN 'success' ELSE 'failure' END;
