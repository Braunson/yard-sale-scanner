ALTER TABLE `items` ADD `goods_type` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `vintage` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `barcode` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `source` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `sold_at` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `condition` text;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `shipping_cents` integer;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `match_score` real;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `original_price_cents` integer;--> statement-breakpoint
ALTER TABLE `valuation_sources` ADD `original_currency` text;