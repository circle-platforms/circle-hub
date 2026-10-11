import type { Migration } from '../../storage/src/index.ts';
export const approvalMigration:Migration={version:6,name:'Revision target and action bound approvals',sql:`
CREATE TABLE approvals (approval_id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks,
 input_revision_id text NOT NULL,applicant_id text NOT NULL REFERENCES policies,target_identity text NOT NULL,
 action_digest text NOT NULL,action jsonb NOT NULL,status text NOT NULL DEFAULT 'open',approved_by text,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
`};
