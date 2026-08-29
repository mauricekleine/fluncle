CREATE TABLE `due_work` (
	`claim_expires_at` text,
	`claim_token` text,
	`claimed_by` text,
	`generation` text NOT NULL,
	`next_due_at` text NOT NULL,
	`sort_key` text NOT NULL,
	`source_version` text NOT NULL,
	`state` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`updated_at` text NOT NULL,
	`work_kind` text NOT NULL,
	PRIMARY KEY(`work_kind`, `subject_type`, `subject_id`),
	CONSTRAINT "due_work_state_check" CHECK("due_work"."state" in ('ready', 'scheduled', 'leased', 'repair')),
	CONSTRAINT "due_work_subject_type_check" CHECK("due_work"."subject_type" in ('track', 'artist', 'album', 'label'))
);
--> statement-breakpoint
CREATE INDEX `due_work_ready_idx` ON `due_work` (`work_kind`,`state`,`sort_key`,`subject_id`) WHERE "due_work"."state" = 'ready';--> statement-breakpoint
CREATE INDEX `due_work_scheduled_idx` ON `due_work` (`work_kind`,`state`,`next_due_at`,`subject_id`) WHERE "due_work"."state" = 'scheduled';--> statement-breakpoint
CREATE INDEX `due_work_repair_idx` ON `due_work` (`state`,`subject_type`,`subject_id`) WHERE "due_work"."state" = 'repair';--> statement-breakpoint
CREATE INDEX `due_work_lease_idx` ON `due_work` (`state`,`claim_expires_at`,`work_kind`,`subject_id`) WHERE "due_work"."state" = 'leased';--> statement-breakpoint
CREATE TABLE `due_work_rebuilds` (
	`completed_at` text,
	`cursor` text,
	`generation` text NOT NULL,
	`projected_count` integer DEFAULT 0 NOT NULL,
	`scanned_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`state` text NOT NULL,
	`subject_type` text NOT NULL,
	`updated_at` text NOT NULL,
	`work_kind` text NOT NULL,
	PRIMARY KEY(`work_kind`, `subject_type`),
	CONSTRAINT "due_work_rebuilds_state_check" CHECK("due_work_rebuilds"."state" in ('running', 'complete')),
	CONSTRAINT "due_work_rebuilds_subject_type_check" CHECK("due_work_rebuilds"."subject_type" in ('track', 'artist', 'album', 'label'))
);
