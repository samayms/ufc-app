CREATE TABLE `aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`person_id` text NOT NULL,
	`alias` text NOT NULL,
	`source` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aliases_person_id_idx` ON `aliases` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_person_alias_unique` ON `aliases` (`person_id`,`alias`);--> statement-breakpoint
CREATE TABLE `bout_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`provider_bout_key` text NOT NULL,
	`espn_bout_id` text NOT NULL,
	`confidence` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`espn_bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bout_mappings_espn_bout_id_idx` ON `bout_mappings` (`espn_bout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bout_mappings_source_key_unique` ON `bout_mappings` (`source`,`provider_bout_key`);--> statement-breakpoint
CREATE TABLE `bout_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bout_id` text NOT NULL,
	`person_id` text NOT NULL,
	`corner` text NOT NULL,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bout_participants_person_id_idx` ON `bout_participants` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bout_participants_bout_corner_unique` ON `bout_participants` (`bout_id`,`corner`);--> statement-breakpoint
CREATE TABLE `bouts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`card_position` integer,
	`weight_class` text,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`result_winner_corner` text,
	`result_method` text,
	`result_round` integer,
	`result_time` text,
	`scheduled_rounds` integer,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bouts_event_id_idx` ON `bouts` (`event_id`);--> statement-breakpoint
CREATE TABLE `commentary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bout_id` text,
	`round` integer,
	`source` text NOT NULL,
	`author` text,
	`body` text NOT NULL,
	`post_id` text,
	`posted_at` text,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commentary_bout_id_idx` ON `commentary` (`bout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `commentary_source_post_unique` ON `commentary` (`source`,`post_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_time` text,
	`venue` text,
	`city` text,
	`country` text,
	`status` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `external_refs_entity_idx` ON `external_refs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_refs_source_external_id_unique` ON `external_refs` (`entity_type`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `fighters` (
	`person_id` text PRIMARY KEY NOT NULL,
	`nickname` text,
	`stance` text,
	`height_cm` real,
	`reach_cm` real,
	`country` text,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`draws` integer DEFAULT 0 NOT NULL,
	`no_contests` integer DEFAULT 0 NOT NULL,
	`ranking` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `latest_market_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bout_id` text NOT NULL,
	`corner` text NOT NULL,
	`source` text NOT NULL,
	`american_odds` integer,
	`implied_probability` real,
	`devig_probability` real,
	`volume_usd` real,
	`synthetic` integer DEFAULT false NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `latest_market_state_bout_id_idx` ON `latest_market_state` (`bout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `latest_market_state_bout_corner_source_unique` ON `latest_market_state` (`bout_id`,`corner`,`source`);--> statement-breakpoint
CREATE TABLE `lifecycle_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text,
	`bout_id` text,
	`type` text NOT NULL,
	`payload` text,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lifecycle_events_bout_id_idx` ON `lifecycle_events` (`bout_id`);--> statement-breakpoint
CREATE INDEX `lifecycle_events_event_id_idx` ON `lifecycle_events` (`event_id`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`source` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_entity_kind_unique` ON `media_assets` (`entity_type`,`entity_id`,`kind`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_markets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`market_id` text NOT NULL,
	`bout_id` text,
	`corner` text,
	`kind` text,
	`volume_usd` real,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `provider_markets_bout_id_idx` ON `provider_markets` (`bout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_markets_source_market_unique` ON `provider_markets` (`source`,`market_id`);--> statement-breakpoint
CREATE TABLE `provider_state` (
	`source` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`last_success_at` text,
	`last_error_at` text,
	`last_error` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `round_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bout_id` text NOT NULL,
	`round` integer NOT NULL,
	`corner` text NOT NULL,
	`stat_name` text NOT NULL,
	`stat_value` real,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `round_stats_bout_id_idx` ON `round_stats` (`bout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `round_stats_unique` ON `round_stats` (`bout_id`,`round`,`corner`,`stat_name`,`source`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_for` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started_at_idx` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `upcoming_odds_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sync_run_id` integer,
	`event_id` text,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `upcoming_odds_snapshots_event_id_idx` ON `upcoming_odds_snapshots` (`event_id`);