import type {Migration} from '../../storage/src/index.ts';
export const conclusionMigration:Migration={version:7,name:'Immutable knowledge snapshots and typed professional conclusions',sql:`
CREATE TABLE knowledge_snapshots(snapshot_id text PRIMARY KEY,tenant_id text NOT NULL,scope_id text NOT NULL,
 sha256 text NOT NULL,sources jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,scope_id,sha256));
ALTER TABLE evidence ALTER COLUMN operation_id DROP NOT NULL;
CREATE TABLE conclusions(conclusion_id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks,input_revision_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('script-conclusion','model-judgment','unknown')),evidence_id text NOT NULL REFERENCES evidence,
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE artifacts ALTER COLUMN source_revision_id DROP NOT NULL;
`};
