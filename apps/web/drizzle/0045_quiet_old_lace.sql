DROP INDEX `mixtape_clips_mixtape_id_idx`;--> statement-breakpoint
ALTER TABLE `mixtape_clips` DROP COLUMN `mixtape_id`;--> statement-breakpoint
ALTER TABLE `mixtapes` DROP COLUMN `planned_for`;--> statement-breakpoint
ALTER TABLE `recordings` DROP COLUMN `tracklist_json`;