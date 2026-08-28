DROP INDEX `items_fingerprint_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `items_fingerprint_unique` ON `items` (`fingerprint`);