CREATE TABLE `label_triage_proposals` (
	`census_summary` text,
	`confidence` text NOT NULL,
	`created_at` text NOT NULL,
	`evidence` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`label_id` text NOT NULL,
	`off_lane_share` real,
	`reason` text,
	`residual_off_lane_share` real,
	`round_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`verdict` text NOT NULL,
	`verify_agrees` integer,
	`verify_evidence` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_triage_proposals_label_idx` ON `label_triage_proposals` (`label_id`);--> statement-breakpoint
CREATE INDEX `label_triage_proposals_round_idx` ON `label_triage_proposals` (`round_id`);--> statement-breakpoint
CREATE TABLE `label_triage_rule_proposals` (
	`artist_mbid` text NOT NULL,
	`artist_name` text NOT NULL,
	`created_at` text NOT NULL,
	`evidence` text,
	`first_credit_count` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`verdict` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `label_triage_rule_proposals_proposal_idx` ON `label_triage_rule_proposals` (`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `label_triage_rule_proposals_artist_idx` ON `label_triage_rule_proposals` (`proposal_id`,`artist_mbid`);--> statement-breakpoint
ALTER TABLE `labels` ADD `triage_checked_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `triage_reason` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `triage_verdict` text;--> statement-breakpoint
CREATE INDEX `labels_triage_queue_idx` ON `labels` (`triage_checked_at`) WHERE "labels"."seed_state" = 'undecided';