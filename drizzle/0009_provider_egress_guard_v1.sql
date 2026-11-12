CREATE TABLE `provider_egress_guard` (
	`bucket` text PRIMARY KEY NOT NULL,
	`window_started_at_ms` integer DEFAULT 0 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`cooldown_until_ms` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "provider_egress_guard_bucket_check" CHECK(bucket IN ('alpaca_quotes_interactive', 'alpaca_bars_interactive', 'alpaca_catalog_interactive', 'alpaca_news_interactive', 'alpaca_news_ingestion')),
	CONSTRAINT "provider_egress_guard_state_check" CHECK(window_started_at_ms >= 0 AND request_count >= 0 AND cooldown_until_ms >= 0 AND julianday(updated_at) IS NOT NULL)
);
