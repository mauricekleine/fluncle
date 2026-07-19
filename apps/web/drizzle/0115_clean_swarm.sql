CREATE TABLE `artist_centroids` (
	`artist_id` text PRIMARY KEY NOT NULL,
	`centroid_blob` F32_BLOB(1024) NOT NULL,
	`computed_at` text NOT NULL,
	`rank_corpus` text NOT NULL,
	`vector_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artist_similar` (
	`artist_id` text NOT NULL,
	`computed_at` text NOT NULL,
	`neighbour_artist_id` text NOT NULL,
	`rank` integer NOT NULL,
	`rank_corpus` text NOT NULL,
	`similarity` real NOT NULL,
	PRIMARY KEY(`artist_id`, `rank`)
);
--> statement-breakpoint
CREATE INDEX `artist_similar_neighbour_idx` ON `artist_similar` (`neighbour_artist_id`);