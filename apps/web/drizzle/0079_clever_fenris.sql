ALTER TABLE `artist_socials` ADD `reviewed_at` text;--> statement-breakpoint
CREATE INDEX `artist_socials_unreviewed_idx` ON `artist_socials` (`reviewed_at`);