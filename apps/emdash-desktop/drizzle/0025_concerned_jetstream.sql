/*
 SQLite does not support "Drop not null from column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html
                  https://stackoverflow.com/questions/2083543/modify-a-columns-type-in-sqlite3

 Due to that we don't generate migration automatically and it has to be done manually
*/--> statement-breakpoint
ALTER TABLE `automations` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_remotes` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_settings` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sync_ts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Hand-written rebuild of `projects` (path becomes nullable) + every table that
-- references it, plus their own children (messages, automation_runs).
--
-- Why this ordering (spec #130, ticket #132): the migration runner executes
-- inside one transaction with `PRAGMA foreign_keys = ON`, so the usual
-- rebuild recipe (CREATE new + INSERT + DROP old `projects`) would fire
-- ON DELETE CASCADE into tasks, conversations, terminals, editor_buffers,
-- project_settings, project_remotes and automations and wipe their rows
-- (PRAGMA foreign_keys=OFF is a no-op inside a transaction). Verified
-- empirically against sqlite 3.51 that the ordering below preserves all rows
-- with foreign_keys=ON:
--   1. create `<table>_new` copies with FK clauses pointing at the `_new`
--      parent tables;
--   2. copy rows from the old tables (in parent-first order);
--   3. drop the old tables -- including `messages` and `automation_runs`,
--      because dropping `conversations` / `automations` fires ON DELETE
--      CASCADE into them (their rows are already copied to `_new`);
--   4. rename each `_new` table into place -- SQLite rewrites FK references
--      to renamed tables automatically;
--   5. recreate every index, including the unique index on `projects.path`
--      (SQLite treats NULLs as distinct, so multiple NULL paths are legal).
CREATE TABLE `projects_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text,
	`workspace_provider` text DEFAULT 'local' NOT NULL,
	`base_ref` text,
	`ssh_connection_id` text,
	`repository_workspace_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`ssh_connection_id`) REFERENCES `ssh_connections`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `project_remotes_new` (
	`project_id` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_url` text NOT NULL,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`project_id`, `remote_name`),
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `project_settings_new` (
	`project_id` text PRIMARY KEY NOT NULL,
	`base_project_settings_json` text DEFAULT '{}' NOT NULL,
	`shareable_project_settings_json` text DEFAULT '{}' NOT NULL,
	`legacy_config_migrated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `tasks_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`workflow_stage` text,
	`board_rank` text,
	`source_branch` text,
	`task_branch` text,
	`linked_issue` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_interacted_at` text,
	`status_changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`workspace_provider` text,
	`workspace_id` text,
	`workspace_provider_data` text,
	`workspace_intent` text,
	`type` text DEFAULT 'task' NOT NULL,
	`automation_run_id` text,
	`assigned_pr_url` text,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_pr_url`) REFERENCES `pull_requests`(`url`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `conversations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`provider` text,
	`config` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_interacted_at` text,
	`is_initial_conversation` integer,
	`session_id` text,
	`agent_status` text,
	`agent_status_seen` integer DEFAULT 1,
	`type` text,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `terminals_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`ssh` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`shell_id` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `editor_buffers_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`file_path` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `automations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project_id` text,
	`trigger_config` text,
	`conversation_config` text,
	`task_config` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_ts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects_new`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE `messages_new` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`content` text NOT NULL,
	`sender` text NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`metadata` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations_new`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `automation_runs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`scheduled_at` integer,
	`deadline_at` integer,
	`started_at` integer,
	`task_created_at` integer,
	`launched_at` integer,
	`finished_at` integer,
	`status` text NOT NULL,
	`error` text,
	`trigger_kind` text NOT NULL,
	`trigger_config_snapshot` text DEFAULT '{}' NOT NULL,
	`conversation_config_snapshot` text DEFAULT '{}' NOT NULL,
	`task_config_snapshot` text,
	`generated_task_name` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations_new`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `projects_new` (`id`, `name`, `path`, `workspace_provider`, `base_ref`, `ssh_connection_id`, `repository_workspace_id`, `created_at`, `updated_at`) SELECT `id`, `name`, `path`, `workspace_provider`, `base_ref`, `ssh_connection_id`, `repository_workspace_id`, `created_at`, `updated_at` FROM `projects`;
INSERT INTO `project_remotes_new` (`project_id`, `remote_name`, `remote_url`) SELECT `project_id`, `remote_name`, `remote_url` FROM `project_remotes`;
INSERT INTO `project_settings_new` (`project_id`, `base_project_settings_json`, `shareable_project_settings_json`, `legacy_config_migrated_at`, `created_at`, `updated_at`) SELECT `project_id`, `base_project_settings_json`, `shareable_project_settings_json`, `legacy_config_migrated_at`, `created_at`, `updated_at` FROM `project_settings`;
INSERT INTO `tasks_new` (`id`, `project_id`, `name`, `status`, `workflow_stage`, `board_rank`, `source_branch`, `task_branch`, `linked_issue`, `archived_at`, `created_at`, `updated_at`, `last_interacted_at`, `status_changed_at`, `is_pinned`, `workspace_provider`, `workspace_id`, `workspace_provider_data`, `workspace_intent`, `type`, `automation_run_id`, `assigned_pr_url`) SELECT `id`, `project_id`, `name`, `status`, `workflow_stage`, `board_rank`, `source_branch`, `task_branch`, `linked_issue`, `archived_at`, `created_at`, `updated_at`, `last_interacted_at`, `status_changed_at`, `is_pinned`, `workspace_provider`, `workspace_id`, `workspace_provider_data`, `workspace_intent`, `type`, `automation_run_id`, `assigned_pr_url` FROM `tasks`;
INSERT INTO `conversations_new` (`id`, `project_id`, `task_id`, `title`, `provider`, `config`, `created_at`, `updated_at`, `last_interacted_at`, `is_initial_conversation`, `session_id`, `agent_status`, `agent_status_seen`, `type`) SELECT `id`, `project_id`, `task_id`, `title`, `provider`, `config`, `created_at`, `updated_at`, `last_interacted_at`, `is_initial_conversation`, `session_id`, `agent_status`, `agent_status_seen`, `type` FROM `conversations`;
INSERT INTO `terminals_new` (`id`, `project_id`, `task_id`, `ssh`, `name`, `shell_id`, `created_at`, `updated_at`) SELECT `id`, `project_id`, `task_id`, `ssh`, `name`, `shell_id`, `created_at`, `updated_at` FROM `terminals`;
INSERT INTO `editor_buffers_new` (`id`, `project_id`, `workspace_id`, `file_path`, `content`, `updated_at`) SELECT `id`, `project_id`, `workspace_id`, `file_path`, `content`, `updated_at` FROM `editor_buffers`;
INSERT INTO `automations_new` (`id`, `name`, `project_id`, `trigger_config`, `conversation_config`, `task_config`, `enabled`, `created_at`, `updated_at`, `deleted_at`) SELECT `id`, `name`, `project_id`, `trigger_config`, `conversation_config`, `task_config`, `enabled`, `created_at`, `updated_at`, `deleted_at` FROM `automations`;
INSERT INTO `messages_new` (`id`, `conversation_id`, `content`, `sender`, `timestamp`, `metadata`) SELECT `id`, `conversation_id`, `content`, `sender`, `timestamp`, `metadata` FROM `messages`;
INSERT INTO `automation_runs_new` (`id`, `automation_id`, `scheduled_at`, `deadline_at`, `started_at`, `task_created_at`, `launched_at`, `finished_at`, `status`, `error`, `trigger_kind`, `trigger_config_snapshot`, `conversation_config_snapshot`, `task_config_snapshot`, `generated_task_name`) SELECT `id`, `automation_id`, `scheduled_at`, `deadline_at`, `started_at`, `task_created_at`, `launched_at`, `finished_at`, `status`, `error`, `trigger_kind`, `trigger_config_snapshot`, `conversation_config_snapshot`, `task_config_snapshot`, `generated_task_name` FROM `automation_runs`;
--> statement-breakpoint
DROP TABLE `messages`;
DROP TABLE `automation_runs`;
DROP TABLE `editor_buffers`;
DROP TABLE `terminals`;
DROP TABLE `conversations`;
DROP TABLE `tasks`;
DROP TABLE `project_settings`;
DROP TABLE `project_remotes`;
DROP TABLE `automations`;
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `projects_new` RENAME TO `projects`;
ALTER TABLE `project_remotes_new` RENAME TO `project_remotes`;
ALTER TABLE `project_settings_new` RENAME TO `project_settings`;
ALTER TABLE `tasks_new` RENAME TO `tasks`;
ALTER TABLE `conversations_new` RENAME TO `conversations`;
ALTER TABLE `terminals_new` RENAME TO `terminals`;
ALTER TABLE `editor_buffers_new` RENAME TO `editor_buffers`;
ALTER TABLE `automations_new` RENAME TO `automations`;
ALTER TABLE `messages_new` RENAME TO `messages`;
ALTER TABLE `automation_runs_new` RENAME TO `automation_runs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_path` ON `projects` (`path`);
CREATE INDEX `idx_projects_ssh_connection_id` ON `projects` (`ssh_connection_id`);
CREATE INDEX `idx_tasks_project_id` ON `tasks` (`project_id`);
CREATE INDEX `idx_conversations_task_id` ON `conversations` (`task_id`);
CREATE INDEX `idx_terminals_task_id` ON `terminals` (`task_id`);
CREATE INDEX `idx_editor_buffers_workspace_file` ON `editor_buffers` (`workspace_id`, `file_path`);
CREATE INDEX `idx_automations_project_id` ON `automations` (`project_id`);
CREATE INDEX `idx_messages_conversation_id` ON `messages` (`conversation_id`);
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);
CREATE INDEX `idx_automation_runs_automation_started` ON `automation_runs` (`automation_id`, `started_at`);
CREATE INDEX `idx_automation_runs_automation_scheduled` ON `automation_runs` (`automation_id`, `scheduled_at`);
CREATE INDEX `idx_automation_runs_automation_status` ON `automation_runs` (`automation_id`, `status`);
CREATE INDEX `idx_automation_runs_status` ON `automation_runs` (`status`);
CREATE INDEX `idx_automation_runs_status_scheduled` ON `automation_runs` (`status`, `scheduled_at`);
--> statement-breakpoint
-- Backfill the sync clock for pre-existing rows with the migration-time ms
-- epoch: the engine's first push runs `WHERE sync_ts > lastPushed` with
-- lastPushed starting at 0, so rows must carry a nonzero clock.
UPDATE `projects` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `project_remotes` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `project_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `tasks` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `conversations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `automations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
--> statement-breakpoint
-- Sync clock triggers: AFTER INSERT/UPDATE stamp the row with the current ms
-- epoch (unixepoch('subsec') * 1000). Recursive triggers are off by default in
-- SQLite, so the inner UPDATE does not re-fire these triggers. The engine
-- (spec #130, ticket #133) reads `sync_ts > lastPushed` for push detection.
CREATE TRIGGER `trg_projects_sync_ts_ins` AFTER INSERT ON `projects` BEGIN UPDATE `projects` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_projects_sync_ts_upd` AFTER UPDATE ON `projects` BEGIN UPDATE `projects` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_project_remotes_sync_ts_ins` AFTER INSERT ON `project_remotes` BEGIN UPDATE `project_remotes` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id` AND `remote_name` = NEW.`remote_name`; END;
CREATE TRIGGER `trg_project_remotes_sync_ts_upd` AFTER UPDATE ON `project_remotes` BEGIN UPDATE `project_remotes` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id` AND `remote_name` = NEW.`remote_name`; END;
CREATE TRIGGER `trg_project_settings_sync_ts_ins` AFTER INSERT ON `project_settings` BEGIN UPDATE `project_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id`; END;
CREATE TRIGGER `trg_project_settings_sync_ts_upd` AFTER UPDATE ON `project_settings` BEGIN UPDATE `project_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id`; END;
CREATE TRIGGER `trg_tasks_sync_ts_ins` AFTER INSERT ON `tasks` BEGIN UPDATE `tasks` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_tasks_sync_ts_upd` AFTER UPDATE ON `tasks` BEGIN UPDATE `tasks` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_conversations_sync_ts_ins` AFTER INSERT ON `conversations` BEGIN UPDATE `conversations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_conversations_sync_ts_upd` AFTER UPDATE ON `conversations` BEGIN UPDATE `conversations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_automations_sync_ts_ins` AFTER INSERT ON `automations` BEGIN UPDATE `automations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_automations_sync_ts_upd` AFTER UPDATE ON `automations` BEGIN UPDATE `automations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
