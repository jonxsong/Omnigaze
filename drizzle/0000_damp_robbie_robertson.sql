CREATE TABLE `event_evidence` (
	`event_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `evidence_id`),
	FOREIGN KEY (`event_id`) REFERENCES `intelligence_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`source_event_id` text NOT NULL,
	`symbol_id` text,
	`classification` text NOT NULL,
	`title` text NOT NULL,
	`publisher` text NOT NULL,
	`source_url` text,
	`locator` text,
	`excerpt` text,
	`published_at` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `source_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_symbol_published_idx` ON `evidence` (`symbol_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`exchange` text NOT NULL,
	`name` text NOT NULL,
	`sector` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intelligence_events` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol_id` text NOT NULL,
	`headline` text NOT NULL,
	`summary` text NOT NULL,
	`category` text NOT NULL,
	`materiality` text NOT NULL,
	`possible_direction` text NOT NULL,
	`status` text DEFAULT 'preliminary' NOT NULL,
	`occurred_at` text NOT NULL,
	`detected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`corrected_by_id` text,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intelligence_symbol_occurred_idx` ON `intelligence_events` (`symbol_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `intelligence_materiality_idx` ON `intelligence_events` (`materiality`);--> statement-breakpoint
CREATE TABLE `omnigaze_views` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol_id` text NOT NULL,
	`horizon` text NOT NULL,
	`stance` text NOT NULL,
	`confidence` real NOT NULL,
	`summary` text NOT NULL,
	`why_now` text NOT NULL,
	`drivers_json` text NOT NULL,
	`unknowns_json` text NOT NULL,
	`model_version` text NOT NULL,
	`data_cutoff` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `views_symbol_generated_idx` ON `omnigaze_views` (`symbol_id`,`generated_at`);--> statement-breakpoint
CREATE TABLE `source_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text NOT NULL,
	`symbol_id` text,
	`published_at` text NOT NULL,
	`observed_at` text NOT NULL,
	`raw_payload_hash` text NOT NULL,
	`raw_payload` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_events_identity_idx` ON `source_events` (`source`,`source_event_id`,`raw_payload_hash`);--> statement-breakpoint
CREATE INDEX `source_events_published_idx` ON `source_events` (`published_at`);--> statement-breakpoint
CREATE INDEX `source_events_symbol_idx` ON `source_events` (`symbol_id`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`watchlist_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	`note` text,
	`added_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`watchlist_id`, `symbol_id`),
	FOREIGN KEY (`watchlist_id`) REFERENCES `watchlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `watchlist_items_symbol_idx` ON `watchlist_items` (`symbol_id`);--> statement-breakpoint
CREATE TABLE `watchlists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `watchlists_owner_idx` ON `watchlists` (`owner_id`);