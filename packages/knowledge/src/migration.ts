import type { Migration } from '../../storage/src/index.ts';
export const knowledgeMigration: Migration = { version: 3, name: 'Immutable sources evidence and artifact bindings', sql: `
CREATE TABLE sources (source_revision_id text PRIMARY KEY, tenant_id text NOT NULL, scope_id text NOT NULL,
 principal_id text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL, object_key text NOT NULL, file_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,scope_id,sha256));
CREATE TABLE evidence (evidence_id text PRIMARY KEY, tenant_id text NOT NULL, scope_id text NOT NULL,
 task_id text NOT NULL REFERENCES tasks, input_revision_id text NOT NULL, operation_id text NOT NULL,
 kind text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL, object_key text NOT NULL,
 metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(operation_id,kind));
CREATE TABLE artifacts (artifact_id text PRIMARY KEY, tenant_id text NOT NULL, scope_id text NOT NULL,
 source_revision_id text NOT NULL REFERENCES sources, compilation_key text NOT NULL, sha256 text NOT NULL,
 size bigint NOT NULL, object_key text NOT NULL, file_name text NOT NULL, media_type text NOT NULL,
 metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,scope_id,compilation_key));
CREATE TABLE artifact_bindings (task_id text NOT NULL REFERENCES tasks, input_revision_id text NOT NULL,
 artifact_id text NOT NULL REFERENCES artifacts, role text NOT NULL, PRIMARY KEY(task_id,input_revision_id,role));
` };
