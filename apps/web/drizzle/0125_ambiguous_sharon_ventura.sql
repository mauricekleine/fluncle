ALTER TABLE `artist_centroids` ADD `centroid_f8` F8_BLOB(1024);--> statement-breakpoint
ALTER TABLE `tracks` ADD `embedding_f8` F8_BLOB(1024);