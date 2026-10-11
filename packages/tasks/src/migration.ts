import type { Migration } from '../../storage/src/index.ts';
export const taskMigration: Migration = { version: 1, name: 'Durable tasks and authenticated governance', sql: `
CREATE TABLE policies (
 principal_id text PRIMARY KEY, tenant_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('user','service','worker')),
 worker_id text, scopes jsonb NOT NULL, grants jsonb NOT NULL, targets jsonb NOT NULL, defects jsonb NOT NULL, disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE auth_tokens (digest text PRIMARY KEY, principal_id text NOT NULL REFERENCES policies, expires_at timestamptz NOT NULL);
CREATE TABLE tasks (
 task_id text PRIMARY KEY CHECK(task_id LIKE 'task_%'), tenant_id text NOT NULL, scope_id text NOT NULL,
 principal_id text NOT NULL REFERENCES policies, title text NOT NULL, phase text NOT NULL,
 input_revision_id text NOT NULL CHECK(input_revision_id LIKE 'inrev_%'), input jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, flow_version text NOT NULL, stage text NOT NULL DEFAULT 'admit',
 cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE input_revisions (input_revision_id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks,
 input jsonb NOT NULL, principal_id text NOT NULL REFERENCES policies, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE idempotency (
 tenant_id text NOT NULL, scope_id text NOT NULL, principal_id text NOT NULL, action text NOT NULL, idem_key text NOT NULL,
 request_hash text NOT NULL, task_id text NOT NULL REFERENCES tasks, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,scope_id,principal_id,action,idem_key)
);
CREATE TABLE event_clock (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), value bigint NOT NULL DEFAULT 0);
INSERT INTO event_clock(singleton,value) VALUES(true,0);
CREATE TABLE outbox (seq bigint PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, kind text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_task_sequence ON outbox(task_id,seq);
CREATE TABLE wakeups (id bigserial PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, reason text NOT NULL,
 processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pending_inputs (request_id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks,
 input_revision_id text NOT NULL, kind text NOT NULL, question text NOT NULL, binding jsonb NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE decisions (id bigserial PRIMARY KEY, request_id text NOT NULL, task_id text NOT NULL REFERENCES tasks,
 principal_id text NOT NULL REFERENCES policies, input_revision_id text NOT NULL, outcome text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE checklist_items (task_id text NOT NULL REFERENCES tasks, input_revision_id text NOT NULL,
 item_id text NOT NULL, requires_fact boolean NOT NULL, satisfied boolean NOT NULL DEFAULT false,
 conclusion_id text, PRIMARY KEY(task_id,input_revision_id,item_id));
CREATE TABLE audit (id bigserial PRIMARY KEY, tenant_id text NOT NULL, scope_id text,
 principal_id text NOT NULL, action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
` };
