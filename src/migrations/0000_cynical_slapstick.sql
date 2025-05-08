CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text,
	`payload` text,
	`type` text NOT NULL,
	`date` integer,
	`delayInSeconds` integer,
	`cron` text,
	`created_at` integer DEFAULT (unixepoch())
);
