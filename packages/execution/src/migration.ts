import type { Migration } from '../../storage/src/index.ts';
export const executionMigration: Migration = { version: 4, name: 'Worker operation ledger leases and monotonic fences', sql: `
CREATE TABLE workers (worker_id text PRIMARY KEY, principal_id text NOT NULL REFERENCES policies, tenant_id text NOT NULL,
 draining boolean NOT NULL DEFAULT false, last_seen timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources (tenant_id text NOT NULL, resource_id text NOT NULL, next_fencing bigint NOT NULL DEFAULT 0,
 frozen boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,resource_id));
CREATE TABLE operations (operation_id text PRIMARY KEY, tenant_id text NOT NULL, scope_id text NOT NULL,
 task_id text NOT NULL REFERENCES tasks, input_revision_id text NOT NULL, principal_id text NOT NULL REFERENCES policies,
 name text NOT NULL, resource_id text NOT NULL, source_revision_id text NOT NULL REFERENCES sources,
 status text NOT NULL, worker_id text, fencing_token bigint, deadline_at timestamptz NOT NULL,
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,input_revision_id,name));
CREATE TABLE leases (tenant_id text NOT NULL, resource_id text NOT NULL, operation_id text NOT NULL REFERENCES operations,
 worker_id text NOT NULL REFERENCES workers, fencing_token bigint NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,resource_id));
` };
