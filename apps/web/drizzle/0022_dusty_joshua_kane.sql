-- Backfill: the mixtape `*_url` columns become `mixtape_social_posts` rows (the
-- single source of truth) BEFORE the columns are dropped. One published row per
-- platform per mixtape that has a link and no existing row (idempotent). Covers the
-- pre-CLI mixtape 019.F.1A whose links were set by hand. external_id stays null —
-- only the post-upload `make public` flow needs the YouTube videoId, and these are
-- already public.
INSERT INTO `mixtape_social_posts` (`id`, `mixtape_id`, `platform`, `status`, `url`, `published_at`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `id`, 'mixcloud', 'published', `mixcloud_url`, coalesce(`published_at`, `updated_at`, `created_at`), `created_at`, `updated_at`
FROM `mixtapes`
WHERE `mixcloud_url` IS NOT NULL AND `mixcloud_url` <> ''
  AND NOT EXISTS (SELECT 1 FROM `mixtape_social_posts` s WHERE s.`mixtape_id` = `mixtapes`.`id` AND s.`platform` = 'mixcloud');--> statement-breakpoint
INSERT INTO `mixtape_social_posts` (`id`, `mixtape_id`, `platform`, `status`, `url`, `published_at`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `id`, 'youtube', 'published', `youtube_url`, coalesce(`published_at`, `updated_at`, `created_at`), `created_at`, `updated_at`
FROM `mixtapes`
WHERE `youtube_url` IS NOT NULL AND `youtube_url` <> ''
  AND NOT EXISTS (SELECT 1 FROM `mixtape_social_posts` s WHERE s.`mixtape_id` = `mixtapes`.`id` AND s.`platform` = 'youtube');--> statement-breakpoint
INSERT INTO `mixtape_social_posts` (`id`, `mixtape_id`, `platform`, `status`, `url`, `published_at`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `id`, 'soundcloud', 'published', `soundcloud_url`, coalesce(`published_at`, `updated_at`, `created_at`), `created_at`, `updated_at`
FROM `mixtapes`
WHERE `soundcloud_url` IS NOT NULL AND `soundcloud_url` <> ''
  AND NOT EXISTS (SELECT 1 FROM `mixtape_social_posts` s WHERE s.`mixtape_id` = `mixtapes`.`id` AND s.`platform` = 'soundcloud');--> statement-breakpoint
ALTER TABLE `mixtapes` DROP COLUMN `mixcloud_url`;--> statement-breakpoint
ALTER TABLE `mixtapes` DROP COLUMN `soundcloud_url`;--> statement-breakpoint
ALTER TABLE `mixtapes` DROP COLUMN `youtube_url`;
