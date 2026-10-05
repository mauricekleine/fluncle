CREATE TABLE `search_page_versions` (
	`changed_at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`submitted_at` text,
	PRIMARY KEY(`kind`, `subject_id`),
	CONSTRAINT "search_page_versions_kind_check" CHECK("search_page_versions"."kind" in ('track', 'artist', 'album', 'label', 'log'))
);
--> statement-breakpoint
CREATE INDEX `search_page_versions_changed_idx` ON `search_page_versions` (`kind`,`changed_at`);--> statement-breakpoint
CREATE INDEX `search_page_versions_due_idx` ON `search_page_versions` (case "kind" when 'log' then 0 when 'artist' then 1 when 'label' then 2 when 'album' then 3 else 4 end,"changed_at" desc,`subject_id`) WHERE "search_page_versions"."submitted_at" is null or "search_page_versions"."submitted_at" < "search_page_versions"."changed_at";