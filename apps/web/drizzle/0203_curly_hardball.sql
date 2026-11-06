ALTER TABLE `labels` ADD `name_fold` text;--> statement-breakpoint
CREATE INDEX `labels_name_fold_idx` ON `labels` (`name_fold`);