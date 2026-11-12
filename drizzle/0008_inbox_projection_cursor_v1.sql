CREATE TABLE `inbox_projection_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_event_id` text NOT NULL,
	`logical_event_id` text NOT NULL,
	`provider` text NOT NULL,
	`partition_key` text NOT NULL,
	`ingestion_run_id` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_projection_changes_run_receipt_idx` ON `inbox_projection_changes` (`provider`,`partition_key`,`ingestion_run_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `inbox_projection_changes_logical_sequence_idx` ON `inbox_projection_changes` (`logical_event_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `inbox_projection_changes_time_idx` ON `inbox_projection_changes` (`changed_at`);--> statement-breakpoint
CREATE TABLE `inbox_projection_cursors` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`claim_until` text,
	`next_allowed_at` text NOT NULL,
	`last_attempt_at` text,
	`last_completed_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "inbox_projection_cursors_lease_check" CHECK((claim_token IS NULL AND claim_until IS NULL) OR (claim_token IS NOT NULL AND claim_until IS NOT NULL)),
	CONSTRAINT "inbox_projection_cursors_counter_check" CHECK(last_sequence >= 0 AND consecutive_failures >= 0)
);
--> statement-breakpoint
CREATE INDEX `inbox_projection_cursors_due_idx` ON `inbox_projection_cursors` (`next_allowed_at`,`last_completed_at`);--> statement-breakpoint
CREATE INDEX `inbox_projection_cursors_lease_idx` ON `inbox_projection_cursors` (`claim_until`);