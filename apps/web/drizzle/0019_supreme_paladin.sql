CREATE TABLE `youtube_auth` (
	`access_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`refresh_token` text NOT NULL,
	`scope` text NOT NULL,
	`service` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL
);
