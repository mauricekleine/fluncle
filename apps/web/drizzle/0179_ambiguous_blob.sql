CREATE UNIQUE INDEX `albums_hub_listing_idx` ON `albums` (`slug`) WHERE ("albums"."certified_finding_count" > 0 or "albums"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE INDEX `albums_name_nocase_idx` ON `albums` ("name" collate nocase);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_hub_listing_idx` ON `artists` (`slug`) WHERE ("artists"."certified_finding_count" > 0 or "artists"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE UNIQUE INDEX `labels_hub_listing_idx` ON `labels` (`slug`) WHERE ("labels"."certified_finding_count" > 0 or "labels"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE INDEX `labels_name_nocase_idx` ON `labels` ("name" collate nocase);