CREATE TABLE `sync_row_state` (
	`table_name` text NOT NULL,
	`pk` text NOT NULL,
	`server_version` integer NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`row_sync_ts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`table_name`, `pk`)
);
--> statement-breakpoint
CREATE TABLE `sync_tombstones` (
	`table_name` text NOT NULL,
	`pk` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`table_name`, `pk`)
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `sync_ts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `kv` ADD `sync_ts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Hand-written additions (spec #130, ticket #133): monotonic sync clocks,
-- sync engine side tables, and deletion tombstones for every allowlisted
-- table.
--
-- The 0025 AFTER UPDATE triggers re-stamp `sync_ts = now` on ANY update —
-- including the engine's own apply of remote rows, and including two app
-- writes within the same millisecond (identical stamps). Both break dirty-row
-- tracking: an applied row would look dirty again (echo loop), and a same-ms
-- edit would look untouched (lost edit). The UPDATE triggers are therefore
-- recreated with a strictly monotonic stamp:
--
--     sync_ts = CASE WHEN NEW.sync_ts > OLD.sync_ts
--                    THEN NEW.sync_ts
--                    ELSE OLD.sync_ts + 1 END
--
-- The engine never writes sync_ts itself (raw-SQL applies write only payload
-- columns), so NEW.sync_ts equals OLD.sync_ts on every app write and the row
-- clock advances by at least 1 per write — two same-ms edits are still
-- distinguishable. The engine's sync_row_state side table records the clock
-- value observed at apply/ack time so an applied remote row is never mistaken
-- for a dirty local edit (the trigger re-stamp loop trap). DELETE triggers
-- feed sync_tombstones, which the engine drains as relay tombstones; the
-- engine clears the entries its own tombstone applies create (DELETE on a
-- missing row fires nothing).
--
-- Backfill the new clocks with the migration-time ms epoch so pre-existing
-- prompt-library/app-settings rows are picked up by the first push
-- (WHERE sync_ts > lastPushed, lastPushed starting at 0).
UPDATE `app_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
UPDATE `kv` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER);
--> statement-breakpoint
DROP TRIGGER `trg_projects_sync_ts_ins`;
DROP TRIGGER `trg_projects_sync_ts_upd`;
DROP TRIGGER `trg_project_remotes_sync_ts_ins`;
DROP TRIGGER `trg_project_remotes_sync_ts_upd`;
DROP TRIGGER `trg_project_settings_sync_ts_ins`;
DROP TRIGGER `trg_project_settings_sync_ts_upd`;
DROP TRIGGER `trg_tasks_sync_ts_ins`;
DROP TRIGGER `trg_tasks_sync_ts_upd`;
DROP TRIGGER `trg_conversations_sync_ts_ins`;
DROP TRIGGER `trg_conversations_sync_ts_upd`;
DROP TRIGGER `trg_automations_sync_ts_ins`;
DROP TRIGGER `trg_automations_sync_ts_upd`;
--> statement-breakpoint
CREATE TRIGGER `trg_projects_sync_ts_ins` AFTER INSERT ON `projects` BEGIN UPDATE `projects` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_projects_sync_ts_upd` AFTER UPDATE ON `projects` BEGIN UPDATE `projects` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_project_remotes_sync_ts_ins` AFTER INSERT ON `project_remotes` BEGIN UPDATE `project_remotes` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id` AND `remote_name` = NEW.`remote_name`; END;
CREATE TRIGGER `trg_project_remotes_sync_ts_upd` AFTER UPDATE ON `project_remotes` BEGIN UPDATE `project_remotes` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `project_id` = NEW.`project_id` AND `remote_name` = NEW.`remote_name`; END;
CREATE TRIGGER `trg_project_settings_sync_ts_ins` AFTER INSERT ON `project_settings` BEGIN UPDATE `project_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `project_id` = NEW.`project_id`; END;
CREATE TRIGGER `trg_project_settings_sync_ts_upd` AFTER UPDATE ON `project_settings` BEGIN UPDATE `project_settings` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `project_id` = NEW.`project_id`; END;
CREATE TRIGGER `trg_tasks_sync_ts_ins` AFTER INSERT ON `tasks` BEGIN UPDATE `tasks` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_tasks_sync_ts_upd` AFTER UPDATE ON `tasks` BEGIN UPDATE `tasks` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_conversations_sync_ts_ins` AFTER INSERT ON `conversations` BEGIN UPDATE `conversations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_conversations_sync_ts_upd` AFTER UPDATE ON `conversations` BEGIN UPDATE `conversations` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_automations_sync_ts_ins` AFTER INSERT ON `automations` BEGIN UPDATE `automations` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_automations_sync_ts_upd` AFTER UPDATE ON `automations` BEGIN UPDATE `automations` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `id` = NEW.`id`; END;
CREATE TRIGGER `trg_app_settings_sync_ts_ins` AFTER INSERT ON `app_settings` BEGIN UPDATE `app_settings` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `key` = NEW.`key`; END;
CREATE TRIGGER `trg_app_settings_sync_ts_upd` AFTER UPDATE ON `app_settings` BEGIN UPDATE `app_settings` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `key` = NEW.`key`; END;
CREATE TRIGGER `trg_kv_sync_ts_ins` AFTER INSERT ON `kv` BEGIN UPDATE `kv` SET `sync_ts` = CAST((unixepoch('subsec') * 1000) AS INTEGER) WHERE `key` = NEW.`key`; END;
CREATE TRIGGER `trg_kv_sync_ts_upd` AFTER UPDATE ON `kv` BEGIN UPDATE `kv` SET `sync_ts` = CASE WHEN NEW.`sync_ts` > OLD.`sync_ts` THEN NEW.`sync_ts` ELSE OLD.`sync_ts` + 1 END WHERE `key` = NEW.`key`; END;
--> statement-breakpoint
-- Deletion tombstones for every allowlisted table (spec #130, ticket #133).
-- Composite primary keys are encoded with json_array() so the relay-side pk
-- string matches the engine's JSON.stringify([...]) encoding byte for byte.
CREATE TRIGGER `trg_projects_sync_ts_del` AFTER DELETE ON `projects` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('projects', `OLD`.`id`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_project_remotes_sync_ts_del` AFTER DELETE ON `project_remotes` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('project_remotes', json_array(`OLD`.`project_id`, `OLD`.`remote_name`), CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_project_settings_sync_ts_del` AFTER DELETE ON `project_settings` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('project_settings', `OLD`.`project_id`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_tasks_sync_ts_del` AFTER DELETE ON `tasks` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('tasks', `OLD`.`id`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_conversations_sync_ts_del` AFTER DELETE ON `conversations` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('conversations', `OLD`.`id`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_automations_sync_ts_del` AFTER DELETE ON `automations` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('automations', `OLD`.`id`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_app_settings_sync_ts_del` AFTER DELETE ON `app_settings` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('app_settings', `OLD`.`key`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;
CREATE TRIGGER `trg_kv_sync_ts_del` AFTER DELETE ON `kv` BEGIN INSERT INTO `sync_tombstones` (`table_name`, `pk`, `created_at`) VALUES ('kv:prompt-library', `OLD`.`key`, CAST((unixepoch('subsec') * 1000) AS INTEGER)); END;