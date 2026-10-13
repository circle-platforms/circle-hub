import type {Migration} from '../../storage/src/index.ts';
export const changeSetMigration:Migration={version:24,name:'Bound change set submissions and scoped policy assets',sql:`
CREATE TABLE change_sets(change_set_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,principal_id text NOT NULL REFERENCES policies,task_id text NOT NULL REFERENCES tasks,items jsonb NOT NULL,submission jsonb NOT NULL,request_hash text NOT NULL,idempotency_key text NOT NULL,target_identity text NOT NULL,identity_digest text NOT NULL,status text NOT NULL DEFAULT 'waiting-review',verification jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,scope_id,principal_id,idempotency_key));
CREATE INDEX change_sets_scope_status ON change_sets(tenant_id,scope_id,status,created_at);
`};
