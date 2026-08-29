CREATE TABLE `artifact_change_revisions` (
	`content_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`event_seq` integer NOT NULL,
	`producer` text NOT NULL,
	`revision` integer NOT NULL,
	`stream` text NOT NULL,
	`stream_version` integer NOT NULL,
	`subject_id` text NOT NULL,
	`subject_type` text NOT NULL,
	PRIMARY KEY(`stream`, `stream_version`, `subject_type`, `subject_id`, `revision`),
	CONSTRAINT "artifact_change_revisions_value_check" CHECK("artifact_change_revisions"."stream_version" >= 1 and "artifact_change_revisions"."revision" >= 1 and "artifact_change_revisions"."event_seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_change_revisions_event_seq_idx` ON `artifact_change_revisions` (`event_seq`);