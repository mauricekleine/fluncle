CREATE TABLE `user_frontier_playlists` (
	`cover_uploaded_at` text,
	`created_at` text NOT NULL,
	`last_synced_at` text,
	`last_uri_hash` text,
	`playlist_id` text NOT NULL,
	`user_id` text PRIMARY KEY NOT NULL
);
