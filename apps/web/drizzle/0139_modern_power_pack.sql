ALTER TABLE `albums` ADD `bio_gate_bypassed_at` text;--> statement-breakpoint
ALTER TABLE `albums` ADD `bio_voice_violations` text;--> statement-breakpoint
CREATE INDEX `albums_bio_review_queue_idx` ON `albums` (`bio_gate_bypassed_at`) WHERE "albums"."bio_gate_bypassed_at" is not null;--> statement-breakpoint
ALTER TABLE `artists` ADD `bio_gate_bypassed_at` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `bio_voice_violations` text;--> statement-breakpoint
CREATE INDEX `artists_bio_review_queue_idx` ON `artists` (`bio_gate_bypassed_at`) WHERE "artists"."bio_gate_bypassed_at" is not null;--> statement-breakpoint
ALTER TABLE `labels` ADD `bio_gate_bypassed_at` text;--> statement-breakpoint
ALTER TABLE `labels` ADD `bio_voice_violations` text;--> statement-breakpoint
CREATE INDEX `labels_bio_review_queue_idx` ON `labels` (`bio_gate_bypassed_at`) WHERE "labels"."bio_gate_bypassed_at" is not null;