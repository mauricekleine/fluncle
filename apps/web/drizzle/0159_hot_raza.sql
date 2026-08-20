CREATE TABLE `track_duplicate_keys` (
	`match_key` text NOT NULL,
	`normalized_isrc` text,
	`track_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`track_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `track_duplicate_keys_match_key_track_id_idx` ON `track_duplicate_keys` (`match_key`,`track_id`);--> statement-breakpoint
CREATE INDEX `track_duplicate_keys_isrc_track_id_idx` ON `track_duplicate_keys` (`normalized_isrc`,`track_id`);