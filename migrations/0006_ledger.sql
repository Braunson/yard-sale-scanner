ALTER TABLE `items` ADD `ledger_purchase_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_purchased_at` text;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_sale_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_sold_at` text;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_platform_id` text;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_fees_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_shipping_cents` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `ledger_estimate_cents` integer;