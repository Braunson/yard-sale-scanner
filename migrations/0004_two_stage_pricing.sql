ALTER TABLE `items` ADD `online_sale_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `shipping_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `pricing_path` text DEFAULT 'research' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `pricing_status` text DEFAULT 'priced' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `triage_source` text DEFAULT 'luna' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `triage_confidence` real;--> statement-breakpoint
ALTER TABLE `items` ADD `research_reason` text;--> statement-breakpoint
ALTER TABLE `items` ADD `researched_at` text;--> statement-breakpoint
ALTER TABLE `items` ADD `research_started_at` text;--> statement-breakpoint
-- Rows saved before two-stage pricing were always researched on the web.
UPDATE `items` SET `researched_at` = `last_seen_at` WHERE `researched_at` IS NULL;
