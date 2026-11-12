CREATE TABLE `sec_fair_access_control` (
	`provider` text PRIMARY KEY NOT NULL,
	`next_admission_at_ms` integer DEFAULT 0 NOT NULL,
	`cooldown_until_ms` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "sec_fair_access_control_provider_check" CHECK(provider = 'sec-edgar'),
	CONSTRAINT "sec_fair_access_control_time_check" CHECK(next_admission_at_ms >= 0 AND cooldown_until_ms >= 0 AND julianday(updated_at) IS NOT NULL)
);
