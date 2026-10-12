import type {Migration} from '../../storage/src/index.ts';

export const automationOutcomeMigration:Migration={version:16,name:'Record isolated automation admission outcomes and coalesced occurrences',sql:`
ALTER TABLE automation_runs ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE automation_runs ADD COLUMN status text NOT NULL DEFAULT 'admitted' CHECK(status IN ('admitted','failed'));
ALTER TABLE automation_runs ADD COLUMN occurrence jsonb NOT NULL DEFAULT '{}';
ALTER TABLE automation_runs ADD COLUMN error jsonb;
ALTER TABLE automation_runs ADD CONSTRAINT automation_run_outcome CHECK(
 (status='admitted' AND task_id IS NOT NULL AND error IS NULL) OR
 (status='failed' AND task_id IS NULL AND error IS NOT NULL));
`};
