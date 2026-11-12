CREATE TABLE `ai_model_budget_reservations` (
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
	CONSTRAINT "ai_model_budget_reservations_bounded_identity_check" CHECK(length(reservation_id) BETWEEN 8 AND 128 AND length(owner_id) BETWEEN 1 AND 256 AND length(request_key_hash) = 64 AND operation = 'omnigaze_view' AND length(operation_key_hash) = 64 AND cost BETWEEN 1 AND 10 AND length(day_start) = 10),
	CONSTRAINT "ai_model_budget_reservations_status_check" CHECK(status IN ('reserved', 'completed', 'failed')),
	CONSTRAINT "ai_model_budget_reservations_time_check" CHECK(julianday(reserved_at) IS NOT NULL AND julianday(lease_expires_at) > julianday(reserved_at) AND (completed_at IS NULL OR julianday(completed_at) >= julianday(reserved_at))),
	CONSTRAINT "ai_model_budget_reservations_terminal_check" CHECK((status = 'reserved' AND completed_at IS NULL AND safe_error_code IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND safe_error_code IS NULL) OR (status = 'failed' AND completed_at IS NOT NULL AND length(safe_error_code) BETWEEN 1 AND 64))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_model_budget_reservations_request_idx` ON `ai_model_budget_reservations` (`owner_id`,`request_key_hash`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_owner_day_idx` ON `ai_model_budget_reservations` (`owner_id`,`day_start`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_owner_time_idx` ON `ai_model_budget_reservations` (`owner_id`,`reserved_at`);--> statement-breakpoint
CREATE INDEX `ai_model_budget_reservations_active_lease_idx` ON `ai_model_budget_reservations` (`owner_id`,`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `ai_view_cache_entries` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`symbol_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model_key` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`response_json` text NOT NULL,
	`generated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_accessed_at` text NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_view_cache_entries_bounded_identity_check" CHECK(length(cache_key) = 64 AND length(symbol_id) BETWEEN 3 AND 64 AND length(prompt_version) BETWEEN 1 AND 128 AND length(model_key) BETWEEN 1 AND 128 AND length(evidence_fingerprint) = 64),
	CONSTRAINT "ai_view_cache_entries_payload_check" CHECK(length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json)),
	CONSTRAINT "ai_view_cache_entries_time_check" CHECK(julianday(generated_at) IS NOT NULL AND julianday(expires_at) > julianday(generated_at) AND julianday(last_accessed_at) IS NOT NULL),
	CONSTRAINT "ai_view_cache_entries_hit_count_check" CHECK(hit_count >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_view_cache_entries_identity_idx` ON `ai_view_cache_entries` (`symbol_id`,`prompt_version`,`model_key`,`evidence_fingerprint`);--> statement-breakpoint
CREATE INDEX `ai_view_cache_entries_expiry_idx` ON `ai_view_cache_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ai_view_cache_entries_symbol_generated_idx` ON `ai_view_cache_entries` (`symbol_id`,`generated_at`);