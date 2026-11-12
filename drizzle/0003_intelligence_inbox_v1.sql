CREATE TABLE `alert_deliveries` (
	`owner_id` text NOT NULL,
	`rule_symbol_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_revision` integer NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`delivered_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `rule_symbol_id`, `event_id`, `event_revision`),
	FOREIGN KEY (`rule_symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `inbox_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "alert_deliveries_revision_check" CHECK(event_revision >= 1),
	CONSTRAINT "alert_deliveries_channel_check" CHECK(channel = 'in_app')
);
--> statement-breakpoint
CREATE INDEX `alert_deliveries_owner_time_idx` ON `alert_deliveries` (`owner_id`,`delivered_at`);--> statement-breakpoint
CREATE INDEX `alert_deliveries_event_idx` ON `alert_deliveries` (`event_id`);--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`owner_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`minimum_materiality` text DEFAULT 'high' NOT NULL,
	`include_controversy` integer DEFAULT false NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `symbol_id`),
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alert_rules_materiality_check" CHECK(minimum_materiality IN ('medium', 'high', 'critical')),
	CONSTRAINT "alert_rules_channel_check" CHECK(channel = 'in_app'),
	CONSTRAINT "alert_rules_version_check" CHECK(version >= 1)
);
--> statement-breakpoint
CREATE INDEX `alert_rules_symbol_idx` ON `alert_rules` (`symbol_id`);--> statement-breakpoint
CREATE TABLE `inbox_event_states` (
	`owner_id` text NOT NULL,
	`event_id` text NOT NULL,
	`read_at` text,
	`read_revision` integer DEFAULT 0 NOT NULL,
	`saved_at` text,
	`dismissed_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`owner_id`, `event_id`),
	FOREIGN KEY (`event_id`) REFERENCES `inbox_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbox_event_states_read_revision_check" CHECK(read_revision >= 0),
	CONSTRAINT "inbox_event_states_version_check" CHECK(version >= 1)
);
--> statement-breakpoint
CREATE INDEX `inbox_event_states_owner_seen_idx` ON `inbox_event_states` (`owner_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `inbox_event_states_event_idx` ON `inbox_event_states` (`event_id`);--> statement-breakpoint
CREATE TABLE `inbox_event_symbols` (
	`event_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `symbol_id`),
	FOREIGN KEY (`event_id`) REFERENCES `inbox_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inbox_event_symbols_symbol_idx` ON `inbox_event_symbols` (`symbol_id`);--> statement-breakpoint
CREATE TABLE `inbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`provider_event_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`headline` text NOT NULL,
	`summary` text,
	`published_at` text NOT NULL,
	`received_at` text NOT NULL,
	`provider_revision_at` text NOT NULL,
	`source_url` text,
	`materiality` text NOT NULL,
	`category` text,
	`claim_status` text,
	`causal_link` text,
	`topic_tags_json` text DEFAULT '[]' NOT NULL,
	`is_controversial` integer DEFAULT false NOT NULL,
	`content_hash` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "inbox_events_materiality_check" CHECK(materiality IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "inbox_events_revision_check" CHECK(revision >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_events_provider_key_idx` ON `inbox_events` (`source`,`provider_event_key`);--> statement-breakpoint
CREATE INDEX `inbox_events_published_idx` ON `inbox_events` (`published_at`);--> statement-breakpoint
CREATE TABLE `inbox_profiles` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`activated_at` text NOT NULL,
	`baseline_completed_at` text,
	`last_checked_at` text NOT NULL,
	`last_successful_sync_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox_sync_gates` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`claim_token` text,
	`claim_until` text,
	`next_allowed_at` text NOT NULL,
	`catchup_pending` integer DEFAULT false NOT NULL,
	`last_attempt_at` text NOT NULL,
	`last_completed_at` text
);
