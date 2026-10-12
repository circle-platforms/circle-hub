import type {Migration} from '../../storage/src/index.ts';
export const automationOriginMigration:Migration={version:18,name:'Index authoritative bot run origins for observed event isolation',sql:`
CREATE INDEX automation_run_tasks ON automation_runs(task_id) WHERE task_id IS NOT NULL;
`};
