/** DDL for the durable C store (ADR 0017). Idempotent. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  phase TEXT NOT NULL,
  input_revision_id TEXT NOT NULL,
  checklist_input_revision_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency (
  principal_id TEXT NOT NULL,
  op_name TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  task_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, op_name, idem_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS pending_inputs (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  sensitive BOOLEAN NOT NULL DEFAULT false,
  input_revision_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS decisions (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL,
  outcome TEXT NOT NULL,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verifications (
  ref_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, ref_id)
);
CREATE TABLE IF NOT EXISTS checklist_items (
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  required BOOLEAN NOT NULL,
  satisfied BOOLEAN NOT NULL DEFAULT false,
  ref_id TEXT,
  PRIMARY KEY (task_id, item_id)
);
CREATE TABLE IF NOT EXISTS scope_members (
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, actor_id)
);
`;
