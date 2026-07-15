ALTER TABLE `albums` ADD `release_group_mbid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `albums_release_group_mbid_idx` ON `albums` (`release_group_mbid`);