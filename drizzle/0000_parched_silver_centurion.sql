CREATE TABLE `events` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	`data` text NOT NULL,
	`payload` text NOT NULL,
	`payload_bytes` integer NOT NULL,
	`document` text,
	`expected_revision` integer,
	PRIMARY KEY(`session_id`, `id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_sequence` ON `events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `document_revisions` (
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`event_id` text NOT NULL,
	`markdown` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `revision`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`goal` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`document` text DEFAULT '' NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`payload_bytes` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
