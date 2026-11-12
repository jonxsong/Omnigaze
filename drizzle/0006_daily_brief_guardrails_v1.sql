CREATE TABLE `ai_daily_brief_cache_entries` (
	`owner_id` text NOT NULL,
	`cache_key` text NOT NULL,
	`brief_date` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model_key` text NOT NULL,
	`watchlist_fingerprint` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`response_json` text NOT NULL,
	`generated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_accessed_at` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `cache_key`),
	CONSTRAINT "ai_daily_brief_cache_entries_bounded_identity_check" CHECK(length(owner_id) BETWEEN 1 AND 256 AND length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*' AND length(brief_date) = 10 AND date(brief_date) = brief_date AND length(prompt_version) BETWEEN 1 AND 128 AND length(model_key) BETWEEN 1 AND 128 AND length(watchlist_fingerprint) = 64 AND watchlist_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ai_daily_brief_cache_entries_payload_check" CHECK(length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json)),
	CONSTRAINT "ai_daily_brief_cache_entries_time_check" CHECK(julianday(generated_at) IS NOT NULL AND julianday(expires_at) > julianday(generated_at) AND julianday(expires_at) <= julianday(generated_at) + 1 AND julianday(last_accessed_at) IS NOT NULL),
	CONSTRAINT "ai_daily_brief_cache_entries_hit_count_check" CHECK(hit_count >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_daily_brief_cache_entries_identity_idx` ON `ai_daily_brief_cache_entries` (`owner_id`,`brief_date`,`prompt_version`,`model_key`,`watchlist_fingerprint`,`evidence_fingerprint`);--> statement-breakpoint
CREATE INDEX `ai_daily_brief_cache_entries_expiry_idx` ON `ai_daily_brief_cache_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ai_daily_brief_cache_entries_owner_date_idx` ON `ai_daily_brief_cache_entries` (`owner_id`,`brief_date`,`generated_at`);--> statement-breakpoint
CREATE TABLE `__new_ai_model_budget_reservations` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`request_key_hash` text NOT NULL,
	`operation` text NOT NULL,
	`operation_key_hash` text NOT NULL,
	`cost` integer DEFAULT 1 NOT NULL,
	`day_start` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`reserved_at` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`completed_at` text,
	`safe_error_code` text,
	CONSTRAINT "ai_model_budget_reservations_bounded_identity_check" CHECK(length(reservation_id) BETWEEN 8 AND 128 AND length(owner_id) BETWEEN 1 AND 256 AND length(request_key_hash) = 64 AND operation IN ('omnigaze_view', 'daily_brief') AND length(operation_key_hash) = 64 AND cost BETWEEN 1 AND 10 AND length(day_start) = 10),
	CONSTRAINT "ai_model_budget_reservations_status_check" CHECK(status IN ('reserved', 'completed', 'failed')),
	CONSTRAINT "ai_model_budget_reservations_time_check" CHECK(julianday(reserved_at) IS NOT NULL AND julianday(lease_expires_at) > julianday(reserved_at) AND (completed_at IS NULL OR julianday(completed_at) >= julianday(reserved_at))),
	CONSTRAINT "ai_model_budget_reservations_terminal_check" CHECK((status = 'reserved' AND completed_at IS NULL AND safe_error_code IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND safe_error_code IS NULL) OR (status = 'failed' AND completed_at IS NOT NULL AND length(safe_error_code) BETWEEN 1 AND 64))
);
--> statement-breakpoint
INSERT INTO `__new_ai_model_budget_reservations`("reservation_id", "owner_id", "request_key_hash", "operation", "operation_key_hash", "cost", "day_start", "status", "reserved_at", "lease_expires_at", "completed_at", "safe_error_code") SELECT "reservation_id", "owner_id", "request_key_hash", "operation", "operation_key_hash", "cost", "day_start", "status", "reserved_at", "lease_expires_at", "completed_at", "safe_error_code" FROM `ai_model_budget_reservations`;--> statement-breakpoint
DROP TABLE `ai_model_budget_reservations`;--> statement-breakpoint
ALTER TABLE `__new_ai_model_budget_reservations` RENAME TO `ai_model_budget_reservations`;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_model_budget_reservations_request_idx` ON `ai_model_budget_reservations` (`owner_id`,`request_key_hash`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_owner_day_idx` ON `ai_model_budget_reservations` (`owner_id`,`day_start`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_owner_time_idx` ON `ai_model_budget_reservations` (`owner_id`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_active_lease_idx` ON `ai_model_budget_reservations` (`owner_id`,`status`,`lease_expires_at`);
