CREATE TABLE `recording_cues` (
	`artists_text` text,
	`created_at` text NOT NULL,
	`finding_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`recording_id` text NOT NULL,
	`start_ms` integer,
	`title_text` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "recording_cues_position_positive" CHECK("position" >= 1),
	CONSTRAINT "recording_cues_start_ms_non_negative" CHECK("start_ms" is null or "start_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_cues_recording_position_idx` ON `recording_cues` (`recording_id`,`position`);--> statement-breakpoint
CREATE INDEX `recording_cues_recording_id_idx` ON `recording_cues` (`recording_id`);--> statement-breakpoint
CREATE INDEX `recording_cues_finding_id_idx` ON `recording_cues` (`finding_id`);--> statement-breakpoint
ALTER TABLE `mixtape_tracks` ADD `artists_text` text;--> statement-breakpoint
ALTER TABLE `mixtape_tracks` ADD `finding_id` text;--> statement-breakpoint
ALTER TABLE `mixtape_tracks` ADD `title_text` text;--> statement-breakpoint
CREATE INDEX `mixtape_tracks_finding_id_idx` ON `mixtape_tracks` (`finding_id`);--> statement-breakpoint
ALTER TABLE `recordings` ADD `note` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `planned_for` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `recordings_parent_id_idx` ON `recordings` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_parent_version_idx` ON `recordings` (`parent_id`,`version`);