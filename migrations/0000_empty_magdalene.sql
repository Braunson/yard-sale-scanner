CREATE TABLE `app_stats` (
	`id` integer PRIMARY KEY NOT NULL,
	`frames_processed` integer DEFAULT 0 NOT NULL,
	`items_identified` integer DEFAULT 0 NOT NULL,
	`searches_performed` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`last_updated` text
);
--> statement-breakpoint
CREATE TABLE `frame_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_session_id` text NOT NULL,
	`captured_at` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`item_count` integer NOT NULL,
	`model_calls` integer NOT NULL,
	`searches_performed` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	FOREIGN KEY (`scan_session_id`) REFERENCES `scan_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `frame_runs_session_idx` ON `frame_runs` (`scan_session_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_session_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`brand` text,
	`model` text,
	`description` text NOT NULL,
	`condition` text NOT NULL,
	`confidence` real NOT NULL,
	`observed_price_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`estimated_low_cents` integer,
	`estimated_high_cents` integer,
	`retail_price_cents` integer,
	`active_price_cents` integer,
	`sold_price_cents` integer,
	`value_summary` text NOT NULL,
	`thumbnail_key` text NOT NULL,
	`raw_json` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`scan_session_id`) REFERENCES `scan_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_fingerprint_idx` ON `items` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `items_session_idx` ON `items` (`scan_session_id`);--> statement-breakpoint
CREATE INDEX `items_last_seen_idx` ON `items` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `scan_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_name` text,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `valuation_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`price_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `valuation_sources_item_idx` ON `valuation_sources` (`item_id`);