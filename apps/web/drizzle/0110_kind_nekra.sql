CREATE TABLE `catalogue_snapshots` (
	`analyzed` integer NOT NULL,
	`analyze_queue` integer NOT NULL,
	`anchored` integer NOT NULL,
	`anchor_backoff` integer NOT NULL,
	`anchor_queue_isrc` integer NOT NULL,
	`anchor_queue_no_isrc` integer NOT NULL,
	`captured` integer NOT NULL,
	`capture_queue` integer NOT NULL,
	`certified` integer NOT NULL,
	`created_at` text NOT NULL,
	`crawled` integer NOT NULL,
	`day` text PRIMARY KEY NOT NULL,
	`embedded` integer NOT NULL,
	`embed_queue` integer NOT NULL,
	`frontier_done` integer NOT NULL,
	`frontier_pending` integer NOT NULL,
	`rec_eligible` integer NOT NULL
);
