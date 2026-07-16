ALTER TABLE `user` ADD `crew_number` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `user_crew_number_unique` ON `user` (`crew_number`);