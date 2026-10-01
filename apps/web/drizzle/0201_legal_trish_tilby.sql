CREATE TABLE `anchor_release_links` (
	`checked_at` text NOT NULL,
	`release_mbid` text PRIMARY KEY NOT NULL,
	`spotify_album_id` text
);
