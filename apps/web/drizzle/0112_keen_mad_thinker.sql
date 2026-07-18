DROP INDEX `crawl_frontier_pick_idx`;--> statement-breakpoint
ALTER TABLE `crawl_frontier` ADD `demand_rank` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `crawl_frontier_pick_idx` ON `crawl_frontier` (`state`,`hop`,`demand_rank`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `tracks` ADD `demand_score` integer;--> statement-breakpoint
CREATE INDEX `tracks_demand_score_idx` ON `tracks` (`demand_score`) WHERE "tracks"."demand_score" is not null;