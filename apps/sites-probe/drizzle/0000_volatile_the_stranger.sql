CREATE TABLE `probe_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`counter` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `probe_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`expected_counter` integer NOT NULL,
	`result_counter` integer NOT NULL,
	`object_key` text NOT NULL
);
