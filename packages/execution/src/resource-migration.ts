import type { Migration } from '../../storage/src/index.ts';
export const resourceMigration: Migration = { version:5,name:'Scoped effects and independent resource reconciliation',sql:`
ALTER TABLE operations ALTER COLUMN source_revision_id DROP NOT NULL;
ALTER TABLE operations DROP CONSTRAINT operations_task_id_input_revision_id_name_key;
CREATE UNIQUE INDEX compile_operation_revision ON operations(task_id,input_revision_id,name) WHERE name='mindmaps.compile';
ALTER TABLE operations ADD COLUMN kind text NOT NULL DEFAULT 'execute';
ALTER TABLE operations ADD COLUMN target text;
ALTER TABLE operations ADD COLUMN target_identity text;
ALTER TABLE operations ADD COLUMN args jsonb NOT NULL DEFAULT '{}';
ALTER TABLE operations ADD COLUMN action_digest text;
ALTER TABLE operations ADD COLUMN effects jsonb;
ALTER TABLE operations ADD COLUMN approval_id text;
ALTER TABLE operations ADD COLUMN parent_operation_id text REFERENCES operations;
ALTER TABLE operations ADD COLUMN delegated_owner_id text;
CREATE TABLE operation_keys (tenant_id text NOT NULL,scope_id text NOT NULL,principal_id text NOT NULL,name text NOT NULL,
 idem_key text NOT NULL,request_hash text NOT NULL,operation_id text NOT NULL REFERENCES operations,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,scope_id,principal_id,name,idem_key));
` };
