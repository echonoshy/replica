CREATE TABLE `documents` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`space_key` text NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`extension` text NOT NULL,
	`mime_type` text NOT NULL,
	`doc_date` text NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`space_key`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_hash_in_space` ON `documents` (`space_key`,`sha256`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`space_key` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text,
	`payload_json` text NOT NULL,
	`progress_json` text NOT NULL,
	`usage_json` text NOT NULL,
	`target_version` integer,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`space_key`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_in_space` ON `jobs` (`space_key`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_created_at` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_space_status` ON `jobs` (`space_key`,`status`);--> statement-breakpoint
CREATE TABLE `space_locks` (
	`space_key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`valid_until` integer NOT NULL,
	FOREIGN KEY (`space_key`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`space_key` text NOT NULL,
	`version` integer NOT NULL,
	`job_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	PRIMARY KEY(`space_key`, `version`),
	FOREIGN KEY (`space_key`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_job_id_unique` ON `snapshots` (`job_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`space_id` text NOT NULL,
	`purpose` text NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`next_version` integer DEFAULT 1 NOT NULL,
	`last_dreamed_at` text,
	`incremental_since_dream` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_identity` ON `spaces` (`namespace`,`space_id`);