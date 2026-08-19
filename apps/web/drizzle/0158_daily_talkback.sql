CREATE TABLE `track_embeddings` (
	`embedding_blob` F32_BLOB(1024) NOT NULL,
	`track_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`track_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `tracks_embed_queue_idx`;--> statement-breakpoint
CREATE INDEX `tracks_embed_queue_idx` ON `tracks` (`track_id`) WHERE "tracks"."source_audio_key" is not null and "tracks"."has_embedding" = 0;