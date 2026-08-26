CREATE TABLE `artist_qualification_contributions` (
	`artist_id` text NOT NULL,
	`certified_contribution` integer NOT NULL,
	`enabled_credit_half_units` integer NOT NULL,
	`generation` text NOT NULL,
	`source_version` text NOT NULL,
	`track_id` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`track_id`, `artist_id`),
	CONSTRAINT "artist_qualification_contributions_certified_check" CHECK("artist_qualification_contributions"."certified_contribution" in (0, 1)),
	CONSTRAINT "artist_qualification_contributions_credit_check" CHECK("artist_qualification_contributions"."enabled_credit_half_units" in (0, 1, 2))
);
--> statement-breakpoint
CREATE INDEX `artist_qualification_contributions_artist_track_idx` ON `artist_qualification_contributions` (`artist_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `crawl_projection_repairs` (
	`created_at` text NOT NULL,
	`source_epoch` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_version` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`source_type`, `source_id`),
	CONSTRAINT "crawl_projection_repairs_source_type_check" CHECK("crawl_projection_repairs"."source_type" in ('label', 'artist')),
	CONSTRAINT "crawl_projection_repairs_epoch_check" CHECK("crawl_projection_repairs"."source_epoch" >= 0)
);
--> statement-breakpoint
CREATE INDEX `crawl_projection_repairs_order_idx` ON `crawl_projection_repairs` (`source_epoch`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `public_aggregate_membership` (
	`generation` text NOT NULL,
	`key_bucket` text,
	`release_date_bucket` text,
	`source_version` text NOT NULL,
	`track_id` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "public_aggregate_membership_release_date_bucket_check" CHECK("public_aggregate_membership"."release_date_bucket" is null or length("public_aggregate_membership"."release_date_bucket") <= 4)
);
--> statement-breakpoint
ALTER TABLE `crawl_due_work` ADD `label_slug` text;--> statement-breakpoint
ALTER TABLE `crawl_due_work` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `crawl_due_work_label_slug_node_id_idx` ON `crawl_due_work` (`label_slug`,`node_id`);--> statement-breakpoint
CREATE INDEX `crawl_due_work_parent_id_node_id_idx` ON `crawl_due_work` (`parent_id`,`node_id`);