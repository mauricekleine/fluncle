DROP INDEX `artists_mbid_idx`;--> statement-breakpoint
CREATE INDEX `artists_mbid_idx` ON `artists` (`mbid`,`slug`);