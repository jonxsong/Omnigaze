CREATE TABLE `portfolio_holdings` (
	`owner_id` text NOT NULL,
	`symbol_id` text NOT NULL,
	`quantity_micros` integer NOT NULL,
	`average_cost_micros` integer,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`quantity_as_of` text NOT NULL,
	`entry_source` text DEFAULT 'user_entered' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `symbol_id`),
	FOREIGN KEY (`symbol_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "portfolio_holdings_quantity_check" CHECK(quantity_micros BETWEEN 1 AND 1000000000000000),
	CONSTRAINT "portfolio_holdings_average_cost_check" CHECK(average_cost_micros IS NULL OR average_cost_micros BETWEEN 0 AND 10000000000000),
	CONSTRAINT "portfolio_holdings_currency_check" CHECK(cost_currency = 'USD'),
	CONSTRAINT "portfolio_holdings_source_check" CHECK(entry_source = 'user_entered'),
	CONSTRAINT "portfolio_holdings_version_check" CHECK(version >= 1)
);
--> statement-breakpoint
CREATE INDEX `portfolio_holdings_symbol_idx` ON `portfolio_holdings` (`symbol_id`);--> statement-breakpoint
CREATE TABLE `portfolio_profiles` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`experience_level` text DEFAULT 'unspecified' NOT NULL,
	`risk_comfort` text DEFAULT 'unspecified' NOT NULL,
	`time_horizon` text DEFAULT 'unspecified' NOT NULL,
	`objective` text DEFAULT 'unspecified' NOT NULL,
	`max_single_position_bps` integer,
	`onboarding_completed_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "portfolio_profiles_base_currency_check" CHECK(base_currency = 'USD'),
	CONSTRAINT "portfolio_profiles_experience_level_check" CHECK(experience_level IN ('unspecified', 'beginner', 'intermediate', 'advanced')),
	CONSTRAINT "portfolio_profiles_risk_comfort_check" CHECK(risk_comfort IN ('unspecified', 'low', 'medium', 'high')),
	CONSTRAINT "portfolio_profiles_time_horizon_check" CHECK(time_horizon IN ('unspecified', 'under_1y', '1_to_3y', '3_to_7y', 'over_7y')),
	CONSTRAINT "portfolio_profiles_objective_check" CHECK(objective IN ('unspecified', 'capital_preservation', 'income', 'balanced_growth', 'growth', 'learning')),
	CONSTRAINT "portfolio_profiles_max_position_check" CHECK(max_single_position_bps IS NULL OR max_single_position_bps BETWEEN 100 AND 10000),
	CONSTRAINT "portfolio_profiles_version_check" CHECK(version >= 1)
);
