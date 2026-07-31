-- Rewrite stored Workflow Stage values onto the new stage enum
-- (idea, exploring, spec, implementing, review, shipped, triage):
--   grilled  -> idea
--   tickets  -> spec
--   pr       -> review
-- `exploring` and `triage` are new stages with no prior data to migrate.
UPDATE `tasks` SET `workflow_stage` = 'idea' WHERE `workflow_stage` = 'grilled';
--> statement-breakpoint
UPDATE `tasks` SET `workflow_stage` = 'spec' WHERE `workflow_stage` = 'tickets';
--> statement-breakpoint
UPDATE `tasks` SET `workflow_stage` = 'review' WHERE `workflow_stage` = 'pr';
