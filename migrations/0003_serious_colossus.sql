ALTER TABLE `frame_runs` ADD `thumbnail_key` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `model` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `instructions` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `input_json` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `events_json` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `raw_responses_json` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `output_json` text;--> statement-breakpoint
ALTER TABLE `frame_runs` ADD `usage_json` text;--> statement-breakpoint
CREATE INDEX `frame_runs_thumbnail_idx` ON `frame_runs` (`thumbnail_key`);