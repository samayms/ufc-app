PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `fighters`;--> statement-breakpoint
CREATE TABLE `fighters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bout_id` text NOT NULL,
	`person_id` text NOT NULL,
	`corner` text NOT NULL,
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
	`locked_at` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`bout_id`) REFERENCES `bouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `fighters_bout_id_idx` ON `fighters` (`bout_id`);--> statement-breakpoint
CREATE INDEX `fighters_person_id_idx` ON `fighters` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fighters_bout_person_unique` ON `fighters` (`bout_id`,`person_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `archived_at` text;