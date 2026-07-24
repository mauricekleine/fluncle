CREATE INDEX `artist_socials_candidate_idx` ON `artist_socials` (`artist_id`) WHERE "artist_socials"."status" = 'candidate';--> statement-breakpoint
CREATE INDEX `artists_name_nocase_idx` ON `artists` ("name" collate nocase,`slug`);--> statement-breakpoint
CREATE INDEX `crawl_frontier_demand_rank0_idx` ON `crawl_frontier` (`state`) WHERE "crawl_frontier"."demand_rank" = 0;--> statement-breakpoint
CREATE INDEX `crawl_frontier_label_node_idx` ON `crawl_frontier` (`state`,`done_at`) WHERE "crawl_frontier"."kind" = 'label' and "crawl_frontier"."source" = 'musicbrainz';