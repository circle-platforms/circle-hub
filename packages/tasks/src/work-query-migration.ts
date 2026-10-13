import type {Migration} from '../../storage/src/index.ts';
export const workQueryMigration:Migration={version:37,name:'Persist task assignment scope service levels and the replay retention floor',sql:`
ALTER TABLE tasks ADD COLUMN assignee_principal_id text REFERENCES policies;
ALTER TABLE tasks ADD COLUMN assigned_at timestamptz;
ALTER TABLE tasks ADD COLUMN due_at timestamptz;
ALTER TABLE scopes ADD COLUMN sla_policy jsonb NOT NULL DEFAULT '{"awaitingMyApproval":86400000,"awaitingMyInput":300000,"submittedByMe":3600000,"assignedToMe":3600000,"exceptions":3600000}'::jsonb;
ALTER TABLE approvals ADD COLUMN superseded_by text;
CREATE INDEX task_assignment_query ON tasks(tenant_id,scope_id,assignee_principal_id);
CREATE INDEX approval_task_status_query ON approvals(task_id,input_revision_id,status,expires_at);
CREATE TABLE outbox_retention(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),discarded_through bigint NOT NULL DEFAULT 0,retained_rows bigint NOT NULL DEFAULT 0);
INSERT INTO outbox_retention(singleton,discarded_through,retained_rows) SELECT true,0,count(*) FROM outbox;
`};
