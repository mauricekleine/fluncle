ALTER TABLE `albums` ADD `latest_release_date` text;--> statement-breakpoint
CREATE INDEX `albums_hub_most_idx` ON `albums` (-"renderable_track_count",`slug`) WHERE ("albums"."certified_finding_count" > 0 or "albums"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE INDEX `albums_hub_recent_idx` ON `albums` (`latest_release_date`,`slug`) WHERE ("albums"."certified_finding_count" > 0 or "albums"."renderable_track_count" >= 3);--> statement-breakpoint
ALTER TABLE `artists` ADD `latest_release_date` text;--> statement-breakpoint
CREATE INDEX `artists_hub_most_idx` ON `artists` (-"renderable_track_count",`slug`) WHERE ("artists"."certified_finding_count" > 0 or "artists"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE INDEX `artists_hub_recent_idx` ON `artists` (`latest_release_date`,`slug`) WHERE ("artists"."certified_finding_count" > 0 or "artists"."renderable_track_count" >= 3);--> statement-breakpoint
ALTER TABLE `labels` ADD `latest_release_date` text;--> statement-breakpoint
CREATE INDEX `labels_hub_most_idx` ON `labels` (-"renderable_track_count",`slug`) WHERE ("labels"."certified_finding_count" > 0 or "labels"."renderable_track_count" >= 3);--> statement-breakpoint
CREATE INDEX `labels_hub_recent_idx` ON `labels` (`latest_release_date`,`slug`) WHERE ("labels"."certified_finding_count" > 0 or "labels"."renderable_track_count" >= 3);