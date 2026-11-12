CREATE TABLE `provider_ingestion_checkpoints` (
	`provider` text NOT NULL,
	`partition_key` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`window_start` text,
	`window_end` text,
	`window_fingerprint` text,
	`resume_cursor` text,
	`high_water_mark` text,
	`next_due_at` text NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`total_successes` integer DEFAULT 0 NOT NULL,
	`total_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`provider`, `partition_key`),
	CONSTRAINT "provider_ingestion_checkpoints_lease_check" CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
	CONSTRAINT "provider_ingestion_checkpoints_window_check" CHECK((window_start IS NULL AND window_end IS NULL AND window_fingerprint IS NULL) OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_fingerprint IS NOT NULL)),
	CONSTRAINT "provider_ingestion_checkpoints_counter_check" CHECK(consecutive_failures >= 0 AND total_successes >= 0 AND total_failures >= 0)
);
--> statement-breakpoint
CREATE INDEX `provider_ingestion_checkpoints_due_idx` ON `provider_ingestion_checkpoints` (`provider`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `provider_ingestion_checkpoints_lease_idx` ON `provider_ingestion_checkpoints` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `provider_ingestion_run_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`code` text NOT NULL,
	`stage` text NOT NULL,
	`safe_message` text NOT NULL,
	`retryable` integer DEFAULT false NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `provider_ingestion_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_ingestion_run_errors_bounded_text_check" CHECK(length(code) BETWEEN 1 AND 64 AND length(stage) BETWEEN 1 AND 64 AND length(safe_message) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX `provider_ingestion_run_errors_run_idx` ON `provider_ingestion_run_errors` (`run_id`);--> statement-breakpoint
CREATE INDEX `provider_ingestion_run_errors_time_idx` ON `provider_ingestion_run_errors` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `provider_ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`partition_key` text NOT NULL,
	`lease_token` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`window_fingerprint` text NOT NULL,
	`resume_cursor_start` text,
	`resume_cursor_end` text,
	`high_water_mark` text,
	`page_fingerprint` text,
	`page_persisted_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`receipt_count` integer DEFAULT 0 NOT NULL,
	`inserted_receipt_count` integer DEFAULT 0 NOT NULL,
	`symbol_link_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "provider_ingestion_runs_status_check" CHECK(status IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "provider_ingestion_runs_counter_check" CHECK(receipt_count >= 0 AND inserted_receipt_count >= 0 AND symbol_link_count >= 0 AND error_count >= 0),
	CONSTRAINT "provider_ingestion_runs_completion_check" CHECK((status = 'running' AND completed_at IS NULL) OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)),
	CONSTRAINT "provider_ingestion_runs_page_check" CHECK((page_fingerprint IS NULL AND page_persisted_at IS NULL) OR (page_fingerprint IS NOT NULL AND page_persisted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_ingestion_runs_lease_idx` ON `provider_ingestion_runs` (`provider`,`partition_key`,`lease_token`);--> statement-breakpoint
CREATE INDEX `provider_ingestion_runs_partition_time_idx` ON `provider_ingestion_runs` (`provider`,`partition_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `provider_ingestion_runs_status_time_idx` ON `provider_ingestion_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `source_event_ingestion_metadata` (
	`source_event_id` text NOT NULL,
	`provider` text NOT NULL,
	`partition_key` text NOT NULL,
	`payload_policy` text NOT NULL,
	`provider_revision_at` text,
	`first_ingestion_run_id` text,
	`last_ingestion_run_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`source_event_id`, `provider`, `partition_key`),
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_ingestion_run_id`) REFERENCES `provider_ingestion_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_ingestion_run_id`) REFERENCES `provider_ingestion_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "source_event_ingestion_metadata_seen_count_check" CHECK(seen_count >= 1),
	CONSTRAINT "source_event_ingestion_metadata_payload_policy_check" CHECK(payload_policy = 'minimal_redacted_v1')
);
--> statement-breakpoint
CREATE INDEX `source_event_ingestion_metadata_partition_idx` ON `source_event_ingestion_metadata` (`provider`,`partition_key`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `source_event_ingestion_metadata_last_run_idx` ON `source_event_ingestion_metadata` (`last_ingestion_run_id`);--> statement-breakpoint
CREATE TABLE `source_event_symbols` (
	`source_event_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	PRIMARY KEY(`source_event_id`, `symbol_id`),
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_event_symbols_symbol_idx` ON `source_event_symbols` (`symbol_id`);